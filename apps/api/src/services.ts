import { randomUUID } from 'node:crypto';
import {
  type Adr,
  type AuditLog,
  adrLabel,
  type Backlog,
  BOARD_COLUMNS,
  type ChatResponse,
  type IndexDocumentRequest,
  type IngestResult,
  type KnowledgeDocument,
  type SearchHit,
  type SessionMetrics,
  type StoryStatus,
  type UserStory,
} from '@specpilot/shared-schemas';
import { COPILOT_SYSTEM, copilotPrompt } from './agents/prompts.js';
import { buildWorkflow, type Emit } from './agents/workflow.js';
import { createBacklogRepository } from './backlog/repository.js';
import { type Database, openDatabase } from './db/database.js';
import { inspectNotes } from './guardrails.js';
import { type CacheStore, openCache } from './llm/cache.js';
import { createLlm, type Provider, providersFromEnv } from './llm/llm.js';
import { createMetrics } from './llm/metrics.js';
import { mockProvider } from './llm/mock-provider.js';
import { createKnowledgeBase } from './rag/knowledge-base.js';
import { adrDocument, SEED_ADRS, SEED_RULES } from './seed.js';

// A camada de serviço: toda regra de negócio do SpecPilot. As rotas HTTP (app.ts) e o
// servidor MCP chamam estas funções e não sabem de banco, de modelo nem de agente.

export class NotFoundError extends Error {}
/** A operação não cabe no estado atual do item: aprovar o que já foi aprovado, mover o que espera aprovação. */
export class ConflictError extends Error {}

export interface ServiceOptions {
  env?: NodeJS.ProcessEnv;
  /** Para teste: provedores falsos no lugar dos do ambiente. */
  providers?: Provider[];
  database?: Database;
  cache?: CacheStore;
  warn?: (message: string) => void;
}

const STATUS_LABEL: Record<StoryStatus, string> = {
  pending_approval: 'aguardando aprovação',
  ready: 'prontas',
  in_progress: 'em andamento',
  done: 'concluídas',
  rejected: 'rejeitadas',
};

export type Services = Awaited<ReturnType<typeof createServices>>;

export async function createServices(options: ServiceOptions = {}) {
  const env = options.env ?? process.env;
  const warn = options.warn ?? ((message: string) => console.warn(message));

  const db = options.database ?? (await openDatabase(env.DATABASE_URL));
  const cache = options.cache ?? (await openCache(env.REDIS_URL, warn));
  const metrics = createMetrics();
  const llm = createLlm({
    providers: options.providers ?? providersFromEnv(env, mockProvider()),
    cache,
    metrics,
    warn,
  });
  const knowledge = createKnowledgeBase(db, llm);
  const backlog = createBacklogRepository(db);
  const workflow = buildWorkflow({ llm, knowledge, listAcceptedAdrs: () => backlog.listAdrs('accepted') });

  // O contexto histórico do projeto de exemplo entra uma vez, com a base vazia.
  if ((await knowledge.list()).length === 0) {
    for (const seed of SEED_ADRS) {
      const adr = await backlog.insertAdr({ ...seed, status: 'accepted' });
      await knowledge.indexDocument(adrDocument(adr));
    }
    for (const rule of SEED_RULES) await knowledge.indexDocument({ kind: 'rule', ...rule });
  }

  async function backlogSummary(): Promise<string> {
    const stories = await backlog.listStories();
    const counts = BOARD_COLUMNS.map(
      (status) => `${stories.filter((story) => story.status === status).length} ${STATUS_LABEL[status]}`,
    );
    const pending = stories.filter((story) => story.status === 'pending_approval').map((story) => story.title);
    const waiting = pending.length > 0 ? ` Aguardando aprovação: ${pending.join('; ')}.` : '';
    return `Backlog com ${stories.filter((story) => story.status !== 'rejected').length} histórias: ${counts.join(', ')}.${waiting}`;
  }

  /** Por que um ADR não mudou de status: não existe, ou já saiu de `proposed`. */
  const adrError = async (id: string, conflict: string) =>
    (await backlog.listAdrs()).some((adr) => adr.id === id)
      ? new ConflictError(conflict)
      : new NotFoundError(`ADR ${id} não existe.`);

  return {
    /** Quem está respondendo e onde os dados vivem: é o que a tela mostra para o avaliador. */
    mode: { provider: llm.provider, store: db.kind, cache: cache.kind },

    // --- Ingestão -----------------------------------------------------------------------------

    /**
     * Roda o workflow multiagente sobre uma nota de reunião e grava o resultado: épicos,
     * histórias (prontas ou aguardando aprovação) e ADRs propostos.
     */
    async ingest(
      notes: string,
      { actor, emit = () => undefined }: { actor: string; emit?: Emit },
    ): Promise<IngestResult> {
      const runId = randomUUID();
      emit({ type: 'run_started', runId });
      const start = performance.now();
      // shortcut: o custo da execução sai da diferença do acumulado da sessão, o que só vale
      // com uma ingestão por vez. Com concorrência, cada chamada precisa carregar o runId.
      const before = metrics.snapshot();

      const guardrail = inspectNotes(notes);
      const state = await workflow.invoke({ notes, guardrail }, { configurable: { emit } });

      const result: Pick<IngestResult, 'epics' | 'stories' | 'proposedAdrs' | 'skippedDuplicates'> = {
        epics: [],
        stories: [],
        proposedAdrs: [],
        skippedDuplicates: 0,
      };
      for (const gatedEpic of state.gated.epics) {
        const epic = await backlog.upsertEpic(gatedEpic.title, gatedEpic.summary);
        result.epics.push(epic);
        for (const story of gatedEpic.stories) {
          // A mesma nota colada duas vezes não duplica o backlog.
          if (await backlog.storyExists(epic.id, story.title)) {
            result.skippedDuplicates++;
            continue;
          }
          result.stories.push(await backlog.insertStory({ ...story, epicId: epic.id }));
        }
      }
      for (const proposal of state.review.proposedAdrs) {
        if (await backlog.adrExists(proposal.title)) continue;
        // ADR sugerido por IA nunca nasce aceito: uma pessoa decide na aba de ADRs.
        result.proposedAdrs.push(await backlog.insertAdr({ ...proposal, status: 'proposed' }));
      }

      const after = metrics.snapshot();
      const pending = result.stories.filter((story) => story.status === 'pending_approval').length;
      await backlog.audit({
        actor,
        action: 'run.completed',
        entityType: 'run',
        entityId: runId,
        details: {
          stories: result.stories.length,
          pendingApproval: pending,
          proposedAdrs: result.proposedAdrs.length,
          conflicts: state.review.conflicts.length,
          guardrail,
          provider: llm.provider,
        },
      });

      return {
        runId,
        ...result,
        conflicts: state.review.conflicts.map((conflict) => ({
          adrNumber: conflict.adrNumber,
          adrTitle: state.acceptedAdrs.find((adr) => adr.number === conflict.adrNumber)?.title ?? '',
          description: conflict.description,
          severity: conflict.severity,
        })),
        context: state.context,
        guardrail,
        metrics: {
          durationMs: Math.round(performance.now() - start),
          llmCalls: after.llmCalls - before.llmCalls,
          cacheHits: after.cacheHits - before.cacheHits,
          estimatedCostUsd: after.estimatedCostUsd - before.estimatedCostUsd,
        },
      };
    },

    // --- Board --------------------------------------------------------------------------------

    async getBacklog(): Promise<Backlog> {
      const [epics, stories] = await Promise.all([backlog.listEpics(), backlog.listStories()]);
      return { epics, stories: stories.filter((story) => story.status !== 'rejected') };
    },

    listStories: (status?: StoryStatus): Promise<UserStory[]> => backlog.listStories(status),
    backlogSummary,

    /** Fecha o loop HITL: só uma pessoa tira uma história de `pending_approval`. */
    async approveStory(id: string, approvedBy: string, actor: string): Promise<UserStory> {
      const story = await backlog.transitionStory(id, ['pending_approval'], 'ready', approvedBy);
      if (!story) {
        if (!(await backlog.findStory(id))) throw new NotFoundError(`História ${id} não existe.`);
        throw new ConflictError('Só uma história aguardando aprovação pode ser aprovada.');
      }
      await backlog.audit({
        actor,
        action: 'story.approved',
        entityType: 'story',
        entityId: id,
        details: { approvedBy },
      });
      return story;
    },

    async rejectStory(id: string, actor: string): Promise<UserStory> {
      const story = await backlog.transitionStory(id, ['pending_approval'], 'rejected');
      if (!story) {
        if (!(await backlog.findStory(id))) throw new NotFoundError(`História ${id} não existe.`);
        throw new ConflictError('Só uma história aguardando aprovação pode ser rejeitada.');
      }
      await backlog.audit({ actor, action: 'story.rejected', entityType: 'story', entityId: id, details: {} });
      return story;
    },

    /** Move um card entre Ready, In Progress e Done. O que espera aprovação não se move: é aprovado. */
    async moveStory(id: string, status: 'ready' | 'in_progress' | 'done', actor: string): Promise<UserStory> {
      const story = await backlog.transitionStory(id, ['ready', 'in_progress', 'done'], status);
      if (!story) {
        if (!(await backlog.findStory(id))) throw new NotFoundError(`História ${id} não existe.`);
        throw new ConflictError('Esta história ainda espera aprovação humana: aprove antes de mover.');
      }
      await backlog.audit({ actor, action: 'story.moved', entityType: 'story', entityId: id, details: { status } });
      return story;
    },

    // --- ADRs e base de conhecimento ----------------------------------------------------------

    listAdrs: (): Promise<Adr[]> => backlog.listAdrs(),

    /** Aceitar um ADR proposto também o indexa: a partir daí ele entra no contexto dos agentes. */
    async approveAdr(id: string, actor: string): Promise<Adr> {
      const adr = await backlog.transitionAdr(id, 'accepted');
      if (!adr) throw await adrError(id, 'Só um ADR proposto pode ser aceito.');
      await knowledge.indexDocument(adrDocument(adr));
      await backlog.audit({
        actor,
        action: 'adr.accepted',
        entityType: 'adr',
        entityId: id,
        details: { adr: adrLabel(adr.number) },
      });
      return adr;
    },

    async rejectAdr(id: string, actor: string): Promise<Adr> {
      const adr = await backlog.transitionAdr(id, 'rejected');
      if (!adr) throw await adrError(id, 'Só um ADR proposto pode ser rejeitado.');
      await backlog.audit({
        actor,
        action: 'adr.rejected',
        entityType: 'adr',
        entityId: id,
        details: { adr: adrLabel(adr.number) },
      });
      return adr;
    },

    listDocuments: (): Promise<KnowledgeDocument[]> => knowledge.list(),

    async indexDocument(input: IndexDocumentRequest, actor: string): Promise<KnowledgeDocument> {
      const document = await knowledge.indexDocument(input);
      await backlog.audit({
        actor,
        action: 'document.indexed',
        entityType: 'document',
        entityId: document.id,
        details: { kind: document.kind, title: document.title },
      });
      return document;
    },

    search: (query: string, limit?: number): Promise<SearchHit[]> => knowledge.search(query, limit),

    // --- Copiloto, métricas e auditoria -------------------------------------------------------

    async chat(question: string): Promise<ChatResponse> {
      const sources = await knowledge.search(question, 3);
      const answer = await llm.generateText({
        system: COPILOT_SYSTEM,
        prompt: copilotPrompt(question, sources, await backlogSummary()),
        tier: 'fast',
        label: 'copilot:answer',
      });
      return { answer, sources };
    },

    sessionMetrics(): SessionMetrics {
      const usage = metrics.snapshot();
      return {
        ...usage,
        avgLatencyMs: Math.round(usage.avgLatencyMs),
        costIsReference: llm.provider === 'mock',
        provider: llm.provider,
        store: db.kind,
        cache: cache.kind,
      };
    },

    listAudit: (limit?: number): Promise<AuditLog[]> => backlog.listAudit(limit),

    async close(): Promise<void> {
      await cache.close();
      await db.close();
    },
  };
}
