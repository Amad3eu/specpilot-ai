import { Adr, IngestResult, SearchHit, type StoryStatus, UserStory } from '@specpilot/shared-schemas';
import { z } from 'zod';

// O servidor MCP não tem banco nem modelo: é uma ponte. Tudo o que ele faz passa pela API
// HTTP do SpecPilot, a mesma que o front-end usa. O que um agente cria por MCP aparece no
// board, e o que uma pessoa aprova no board o agente enxerga.

/** Uma chamada à API. Em produção é `fetch`; no teste, a aplicação Fastify em processo. */
export type Requester = (
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
) => Promise<{ status: number; json: unknown }>;

/** A API respondeu com erro: o texto é o que ela explicou, pronto para devolver ao agente. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const ErrorBody = z.object({ error: z.string(), issues: z.string().optional() });

export type SpecPilotClient = ReturnType<typeof createClient>;

export function createClient(request: Requester) {
  const call = async <T>(method: 'GET' | 'POST', path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> => {
    const { status, json } = await request(method, path, body);
    if (status >= 400) {
      const parsed = ErrorBody.safeParse(json);
      const detail = parsed.success
        ? [parsed.data.error, parsed.data.issues].filter(Boolean).join('\n')
        : `HTTP ${status}`;
      throw new ApiError(status, detail);
    }
    // A resposta da API também é entrada externa: passa pelo contrato antes de virar texto para o agente.
    return schema.parse(json);
  };

  return {
    ingest: (notes: string) => call('POST', '/api/ingest', IngestResult, { notes }),
    listStories: async (status?: StoryStatus) => {
      const { stories } = await call('GET', '/api/backlog', z.object({ stories: z.array(UserStory) }));
      return status ? stories.filter((story) => story.status === status) : stories;
    },
    approveStory: (id: string, approvedBy: string) =>
      call('POST', `/api/stories/${encodeURIComponent(id)}/approve`, UserStory, { approvedBy }),
    search: (query: string, limit: number) =>
      call('GET', `/api/knowledge/search?q=${encodeURIComponent(query)}&limit=${limit}`, z.array(SearchHit)),
    backlogSummary: async () => (await call('GET', '/api/backlog/summary', z.object({ summary: z.string() }))).summary,
    listAdrs: () => call('GET', '/api/adrs', z.array(Adr)),
  };
}

/** O requester de produção: HTTP para a API, identificado como cliente MCP na trilha de auditoria. */
export function httpRequester(baseUrl: string): Requester {
  return async (method, path, body) => {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        'x-specpilot-actor': 'mcp',
        // Só com corpo: a API recusa um pedido que se diz JSON e chega vazio.
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
}
