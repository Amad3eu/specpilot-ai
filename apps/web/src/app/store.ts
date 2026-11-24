import { computed, Injectable, inject, signal } from '@angular/core';
import type {
  Adr,
  AgentName,
  IndexDocumentRequest,
  IngestResult,
  KnowledgeDocument,
  SearchHit,
  SessionMetrics,
  StoryStatus,
  UserStory,
} from '@specpilot/shared-schemas';
import { BOARD_COLUMNS } from '@specpilot/shared-schemas/constants';
import { type ApiMode, SpecPilotApi } from './api';

// O estado da tela, em signals. Os componentes leem daqui e chamam estes métodos; ninguém
// mais fala com a API. Depois de cada ação o estado é relido do servidor: a fonte da verdade
// é o backlog da API, que um agente pode ter mudado por MCP enquanto a tela estava aberta.

export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/** Os quatro agentes do workflow, na ordem em que rodam. */
export const AGENTS: Array<{ name: AgentName; label: string; does: string }> = [
  { name: 'context_retriever', label: 'Contexto', does: 'Busca ADRs e regras do projeto' },
  { name: 'product_analyst', label: 'Analista de produto', does: 'Escreve épicos, histórias e Gherkin' },
  { name: 'architect_reviewer', label: 'Revisor de arquitetura', does: 'Confronta a nota com os ADRs' },
  { name: 'human_approval_gate', label: 'Gate de aprovação', does: 'Separa o que espera uma pessoa' },
];

export interface AgentStep {
  state: 'waiting' | 'running' | 'done';
  summary: string;
  durationMs: number | null;
}

export interface ChatMessage {
  from: 'user' | 'copilot';
  text: string;
  sources: SearchHit[];
}

const idle = (): Record<AgentName, AgentStep> => ({
  context_retriever: { state: 'waiting', summary: '', durationMs: null },
  product_analyst: { state: 'waiting', summary: '', durationMs: null },
  architect_reviewer: { state: 'waiting', summary: '', durationMs: null },
  human_approval_gate: { state: 'waiting', summary: '', durationMs: null },
});

@Injectable({ providedIn: 'root' })
export class SpecPilotStore {
  private readonly api = inject(SpecPilotApi);

  readonly stories = signal<UserStory[]>([]);
  readonly epicTitles = signal<Record<string, string>>({});
  readonly adrs = signal<Adr[]>([]);
  readonly documents = signal<KnowledgeDocument[]>([]);
  readonly metrics = signal<SessionMetrics | null>(null);
  readonly mode = signal<ApiMode | null>(null);

  readonly running = signal(false);
  readonly steps = signal<Record<AgentName, AgentStep>>(idle());
  readonly lastRun = signal<IngestResult | null>(null);
  /** A última falha, na voz da interface. `null` quando a última ação deu certo. */
  readonly error = signal<string | null>(null);

  readonly searchHits = signal<SearchHit[] | null>(null);
  readonly chat = signal<ChatMessage[]>([]);
  readonly asking = signal(false);

  /** As histórias de cada coluna do board. */
  readonly columns = computed(() => {
    const byStatus = Object.fromEntries(BOARD_COLUMNS.map((status) => [status, [] as UserStory[]])) as Record<
      BoardColumn,
      UserStory[]
    >;
    for (const story of this.stories()) {
      if (story.status !== 'rejected') byStatus[story.status].push(story);
    }
    return byStatus;
  });

  readonly pendingCount = computed(() => this.columns().pending_approval.length);
  readonly proposedAdrs = computed(() => this.adrs().filter((adr) => adr.status === 'proposed'));

  /** Roda a ação e registra a falha para a tela mostrar. Devolve se deu certo. */
  private async attempt(action: () => Promise<void>): Promise<boolean> {
    try {
      await action();
      this.error.set(null);
      return true;
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Algo falhou. Tente de novo.');
      return false;
    }
  }

  /** Relê do servidor tudo o que a tela mostra. */
  private async reload(): Promise<void> {
    const [health, backlog, adrs, documents, metrics] = await Promise.all([
      this.api.health(),
      this.api.backlog(),
      this.api.adrs(),
      this.api.documents(),
      this.api.metrics(),
    ]);
    this.mode.set(health.mode);
    this.stories.set(backlog.stories);
    this.epicTitles.set(Object.fromEntries(backlog.epics.map((epic) => [epic.id, epic.title])));
    this.adrs.set(adrs);
    this.documents.set(documents);
    this.metrics.set(metrics);
  }

  /** A carga inicial da tela. */
  refresh = () => this.attempt(() => this.reload());

  /**
   * Relê depois de uma ação, sem apagar o erro dela: se a ação falhou, a mensagem que fica
   * na tela é o motivo da falha, não o sucesso da releitura.
   */
  private async reloadAfter(ok: boolean): Promise<void> {
    try {
      await this.reload();
    } catch (error) {
      if (ok) this.error.set(error instanceof Error ? error.message : 'Não foi possível atualizar a tela.');
    }
  }

  /** Manda a nota de reunião para o workflow e acompanha cada agente. */
  async ingest(notes: string): Promise<void> {
    this.running.set(true);
    this.steps.set(idle());
    this.lastRun.set(null);
    const ok = await this.attempt(() =>
      this.api.ingest(notes, (event) => {
        if (event.type === 'agent_started') {
          this.steps.update((steps) => ({ ...steps, [event.agent]: { ...steps[event.agent], state: 'running' } }));
        } else if (event.type === 'agent_finished') {
          this.steps.update((steps) => ({
            ...steps,
            [event.agent]: { state: 'done', summary: event.summary, durationMs: event.durationMs },
          }));
        } else if (event.type === 'result') {
          this.lastRun.set(event.result);
        } else if (event.type === 'error') {
          throw new Error(event.message);
        }
      }),
    );
    this.running.set(false);
    await this.reloadAfter(ok);
  }

  approve = (story: UserStory, approvedBy: string) =>
    this.act(async () => void (await this.api.approveStory(story.id, approvedBy)));
  reject = (story: UserStory) => this.act(async () => void (await this.api.rejectStory(story.id)));
  move = (story: UserStory, status: Exclude<StoryStatus, 'pending_approval' | 'rejected'>) =>
    this.act(async () => void (await this.api.moveStory(story.id, status)));

  approveAdr = (adr: Adr) => this.act(async () => void (await this.api.approveAdr(adr.id)));
  rejectAdr = (adr: Adr) => this.act(async () => void (await this.api.rejectAdr(adr.id)));
  indexDocument = (document: IndexDocumentRequest) =>
    this.act(async () => void (await this.api.indexDocument(document)));

  /** Uma ação que muda o servidor: executa e relê o estado. Devolve se deu certo. */
  private async act(action: () => Promise<void>): Promise<boolean> {
    const ok = await this.attempt(action);
    // Relê mesmo quando falha: se outra pessoa (ou um agente) mexeu no item, a tela se corrige.
    await this.reloadAfter(ok);
    return ok;
  }

  async search(query: string): Promise<void> {
    await this.attempt(async () => this.searchHits.set(await this.api.search(query)));
  }

  async ask(question: string): Promise<void> {
    this.chat.update((messages) => [...messages, { from: 'user', text: question, sources: [] }]);
    this.asking.set(true);
    await this.attempt(async () => {
      const { answer, sources } = await this.api.chat(question);
      this.chat.update((messages) => [...messages, { from: 'copilot', text: answer, sources }]);
    });
    this.asking.set(false);
    await this.attempt(async () => this.metrics.set(await this.api.metrics()));
  }
}
