import {
  ApprovalRequest,
  ChatRequest,
  IndexDocumentRequest,
  IngestRequest,
  MoveStoryRequest,
  type StreamEvent,
} from '@specpilot/shared-schemas';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ConflictError, NotFoundError, type Services } from './services.js';

// A borda HTTP. Cada rota valida a entrada com o contrato de @specpilot/shared-schemas,
// chama um serviço e devolve o resultado. Regra de negócio não mora aqui.

const SearchQuery = z.object({
  q: z.string().trim().min(2).max(500),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});
const IdParams = z.object({ id: z.string().min(1) });

/** Quem está agindo, para a trilha de auditoria: o board, um cliente MCP ou outro chamador da API. */
const actorOf = (request: FastifyRequest) => {
  const header = request.headers['x-specpilot-actor'];
  return typeof header === 'string' && header.trim() ? header.trim().slice(0, 80) : 'api';
};

export function buildApp(services: Services): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.status(400).send({ error: 'Entrada inválida.', issues: z.prettifyError(error) });
    }
    if (error instanceof NotFoundError) return reply.status(404).send({ error: error.message });
    if (error instanceof ConflictError) return reply.status(409).send({ error: error.message });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: error instanceof Error ? error.message : 'Pedido inválido.' });
    }
    // O detalhe de um erro interno fica no log do servidor, não na resposta.
    console.error(error);
    return reply.status(500).send({ error: 'Erro interno.' });
  });

  app.get('/api/health', async () => ({ status: 'ok', mode: services.mode }));

  // --- Ingestão ---------------------------------------------------------------------------------

  app.post('/api/ingest', async (request) => {
    const { notes } = IngestRequest.parse(request.body);
    return services.ingest(notes, { actor: actorOf(request) });
  });

  /** A mesma ingestão, com o andamento de cada agente em Server-Sent Events. */
  app.post('/api/ingest/stream', async (request, reply) => {
    const { notes } = IngestRequest.parse(request.body);
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (event: StreamEvent) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    try {
      const result = await services.ingest(notes, { actor: actorOf(request), emit: send });
      send({ type: 'result', result });
    } catch (error) {
      console.error(error);
      send({ type: 'error', message: 'O workflow falhou. Veja o log da API.' });
    } finally {
      reply.raw.end();
    }
  });

  // --- Board ------------------------------------------------------------------------------------

  app.get('/api/backlog', async () => services.getBacklog());
  app.get('/api/backlog/summary', async () => ({ summary: await services.backlogSummary() }));

  app.post('/api/stories/:id/approve', async (request) => {
    const { id } = IdParams.parse(request.params);
    const { approvedBy } = ApprovalRequest.parse(request.body ?? {});
    return services.approveStory(id, approvedBy, actorOf(request));
  });

  app.post('/api/stories/:id/reject', async (request) => {
    const { id } = IdParams.parse(request.params);
    return services.rejectStory(id, actorOf(request));
  });

  app.patch('/api/stories/:id', async (request) => {
    const { id } = IdParams.parse(request.params);
    const { status } = MoveStoryRequest.parse(request.body);
    return services.moveStory(id, status, actorOf(request));
  });

  // --- ADRs e base de conhecimento ----------------------------------------------------------------

  app.get('/api/adrs', async () => services.listAdrs());

  app.post('/api/adrs/:id/approve', async (request) => {
    const { id } = IdParams.parse(request.params);
    return services.approveAdr(id, actorOf(request));
  });

  app.post('/api/adrs/:id/reject', async (request) => {
    const { id } = IdParams.parse(request.params);
    return services.rejectAdr(id, actorOf(request));
  });

  app.get('/api/knowledge', async () => services.listDocuments());

  app.post('/api/knowledge', async (request, reply) => {
    const document = await services.indexDocument(IndexDocumentRequest.parse(request.body), actorOf(request));
    return reply.status(201).send(document);
  });

  app.get('/api/knowledge/search', async (request) => {
    const { q, limit } = SearchQuery.parse(request.query);
    return services.search(q, limit);
  });

  // --- Copiloto, métricas e auditoria -------------------------------------------------------------

  app.post('/api/chat', async (request) => {
    const { question } = ChatRequest.parse(request.body);
    return services.chat(question);
  });

  app.get('/api/metrics', async () => services.sessionMetrics());
  app.get('/api/audit', async () => services.listAudit());

  return app;
}
