import { Injectable } from '@angular/core';
import type {
  Adr,
  Backlog,
  ChatResponse,
  IndexDocumentRequest,
  KnowledgeDocument,
  SearchHit,
  SessionMetrics,
  StreamEvent,
  UserStory,
} from '@specpilot/shared-schemas';
import { readEventStream } from './sse';

// O cliente da API do SpecPilot. Os tipos vêm de @specpilot/shared-schemas, o mesmo contrato
// que a API valida. Em desenvolvimento, /api é encaminhado para a porta 3333 (proxy.conf.json).

/** A API explicou por que recusou o pedido: a mensagem vai para a tela como está. */
export class ApiError extends Error {}

export interface ApiMode {
  provider: string;
  store: 'postgres' | 'memory';
  cache: 'redis' | 'memory';
}

@Injectable({ providedIn: 'root' })
export class SpecPilotApi {
  private async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`/api${path}`, {
        method,
        headers: {
          // O board se identifica: é o que aparece como "quem agiu" na trilha de auditoria.
          'x-specpilot-actor': 'board',
          // Só com corpo: a API recusa um pedido que se diz JSON e chega vazio.
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError('A API não respondeu. Ela está no ar? Rode "pnpm dev" na raiz do projeto.');
    }
    const json = await response.json().catch(() => null);
    if (!response.ok) throw new ApiError(json?.error ?? `A API respondeu com erro ${response.status}.`);
    return json as T;
  }

  health = () => this.request<{ status: string; mode: ApiMode }>('GET', '/health');
  backlog = () => this.request<Backlog>('GET', '/backlog');
  adrs = () => this.request<Adr[]>('GET', '/adrs');
  documents = () => this.request<KnowledgeDocument[]>('GET', '/knowledge');
  metrics = () => this.request<SessionMetrics>('GET', '/metrics');

  approveStory = (id: string, approvedBy: string) =>
    this.request<UserStory>('POST', `/stories/${id}/approve`, { approvedBy });
  rejectStory = (id: string) => this.request<UserStory>('POST', `/stories/${id}/reject`);
  moveStory = (id: string, status: 'ready' | 'in_progress' | 'done') =>
    this.request<UserStory>('PATCH', `/stories/${id}`, { status });

  approveAdr = (id: string) => this.request<Adr>('POST', `/adrs/${id}/approve`);
  rejectAdr = (id: string) => this.request<Adr>('POST', `/adrs/${id}/reject`);
  indexDocument = (document: IndexDocumentRequest) => this.request<KnowledgeDocument>('POST', '/knowledge', document);
  search = (query: string) => this.request<SearchHit[]>('GET', `/knowledge/search?q=${encodeURIComponent(query)}`);
  chat = (question: string) => this.request<ChatResponse>('POST', '/chat', { question });

  /** Roda o workflow multiagente e entrega o andamento de cada agente enquanto ele acontece. */
  async ingest(notes: string, onEvent: (event: StreamEvent) => void): Promise<void> {
    let response: Response;
    try {
      response = await fetch('/api/ingest/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-specpilot-actor': 'board' },
        body: JSON.stringify({ notes }),
      });
    } catch {
      throw new ApiError('A API não respondeu. Ela está no ar? Rode "pnpm dev" na raiz do projeto.');
    }
    if (!response.ok) {
      const json = await response.json().catch(() => null);
      throw new ApiError(json?.error ?? `A API respondeu com erro ${response.status}.`);
    }
    await readEventStream(response, onEvent);
  }
}
