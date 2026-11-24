import { z } from 'zod';
import { BOARD_COLUMNS, STREAM_EVENT_TYPES } from './constants.js';

export { adrLabel, BOARD_COLUMNS, STREAM_EVENT_TYPES } from './constants.js';

// Os contratos do SpecPilot. API, web e servidor MCP importam daqui: o que atravessa uma
// fronteira (HTTP, SSE, MCP, banco) é validado com estes schemas, e os tipos saem deles.
//
// O front importa daqui só os tipos. Os valores sem Zod que ele usa ficam em constants.ts.

// --- Backlog ------------------------------------------------------------------------------------

/** As quatro colunas do board, mais `rejected`, que sai do board. */
export const StoryStatus = z.enum(['pending_approval', 'ready', 'in_progress', 'done', 'rejected']);
export type StoryStatus = z.infer<typeof StoryStatus>;

// As colunas do board (constants.ts) têm que ser status que existem.
BOARD_COLUMNS satisfies readonly StoryStatus[];

export const Level = z.enum(['high', 'medium', 'low']);
export type Level = z.infer<typeof Level>;

/** Um cenário Gherkin: Dado, Quando, Então. */
export const AcceptanceCriterion = z.object({
  scenario: z.string().min(1),
  given: z.string().min(1),
  when: z.string().min(1),
  then: z.string().min(1),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterion>;

export const Epic = z.object({
  id: z.string(),
  title: z.string().min(1),
  summary: z.string(),
  createdAt: z.string(),
});
export type Epic = z.infer<typeof Epic>;

export const UserStory = z.object({
  id: z.string(),
  epicId: z.string(),
  title: z.string().min(1),
  asA: z.string().min(1),
  iWant: z.string().min(1),
  soThat: z.string().min(1),
  acceptanceCriteria: z.array(AcceptanceCriterion).min(1),
  priority: Level,
  /** Quanto custa errar: mexe com dinheiro, dado pessoal, segurança ou migração? */
  impact: Level,
  /** Confiança do agente na história, de 0 a 1. */
  confidence: z.number().min(0).max(1),
  status: StoryStatus,
  /** Por que o item parou na aprovação humana. Vazio quando foi direto para `ready`. */
  approvalReasons: z.array(z.string()),
  approvedBy: z.string().nullable(),
  createdAt: z.string(),
});
export type UserStory = z.infer<typeof UserStory>;

// --- Arquitetura e base de conhecimento ---------------------------------------------------------

export const AdrStatus = z.enum(['proposed', 'accepted', 'rejected']);
export type AdrStatus = z.infer<typeof AdrStatus>;

export const Adr = z.object({
  id: z.string(),
  /** O número do ADR: ADR-001, ADR-002... */
  number: z.number().int().positive(),
  title: z.string().min(1),
  status: AdrStatus,
  context: z.string(),
  decision: z.string(),
  consequences: z.string(),
  createdAt: z.string(),
});
export type Adr = z.infer<typeof Adr>;

export const ArchitectureConflict = z.object({
  /** O ADR aceito com o qual a nota de reunião bate de frente. */
  adrNumber: z.number().int().positive(),
  adrTitle: z.string(),
  description: z.string().min(1),
  severity: Level,
});
export type ArchitectureConflict = z.infer<typeof ArchitectureConflict>;

export const DocumentKind = z.enum(['adr', 'rule', 'doc']);
export type DocumentKind = z.infer<typeof DocumentKind>;

export const KnowledgeDocument = z.object({
  id: z.string(),
  kind: DocumentKind,
  title: z.string().min(1),
  content: z.string().min(1),
  createdAt: z.string(),
});
export type KnowledgeDocument = z.infer<typeof KnowledgeDocument>;

export const IndexDocumentRequest = z.object({
  kind: DocumentKind.default('doc'),
  title: z.string().trim().min(3).max(160),
  content: z.string().trim().min(20).max(20_000),
});
export type IndexDocumentRequest = z.infer<typeof IndexDocumentRequest>;

/** Um trecho devolvido pela busca híbrida. O score é a soma do RRF, não uma probabilidade. */
export const SearchHit = z.object({
  documentId: z.string(),
  kind: DocumentKind,
  title: z.string(),
  snippet: z.string(),
  score: z.number(),
});
export type SearchHit = z.infer<typeof SearchHit>;

// --- Ingestão: a nota de reunião e o resultado do workflow --------------------------------------

export const IngestRequest = z.object({
  notes: z.string().trim().min(20, 'Cole pelo menos uma frase da reunião.').max(20_000),
});
export type IngestRequest = z.infer<typeof IngestRequest>;

export const GuardrailReport = z.object({
  /** A nota trazia texto com cara de instrução para o modelo? */
  flagged: z.boolean(),
  reasons: z.array(z.string()),
});
export type GuardrailReport = z.infer<typeof GuardrailReport>;

export const RunMetrics = z.object({
  durationMs: z.number(),
  llmCalls: z.number().int(),
  cacheHits: z.number().int(),
  estimatedCostUsd: z.number(),
});
export type RunMetrics = z.infer<typeof RunMetrics>;

export const IngestResult = z.object({
  runId: z.string(),
  epics: z.array(Epic),
  stories: z.array(UserStory),
  proposedAdrs: z.array(Adr),
  conflicts: z.array(ArchitectureConflict),
  /** O que a busca híbrida trouxe para o contexto dos agentes. */
  context: z.array(SearchHit),
  guardrail: GuardrailReport,
  /** Histórias que já existiam no backlog com o mesmo título e não foram criadas de novo. */
  skippedDuplicates: z.number().int(),
  metrics: RunMetrics,
});
export type IngestResult = z.infer<typeof IngestResult>;

// --- Stream: o andamento do workflow, um evento por linha de SSE --------------------------------

export const AgentName = z.enum(['context_retriever', 'product_analyst', 'architect_reviewer', 'human_approval_gate']);
export type AgentName = z.infer<typeof AgentName>;

export const StreamEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run_started'), runId: z.string() }),
  z.object({ type: z.literal('agent_started'), agent: AgentName }),
  z.object({ type: z.literal('agent_finished'), agent: AgentName, summary: z.string(), durationMs: z.number() }),
  z.object({ type: z.literal('result'), result: IngestResult }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type StreamEvent = z.infer<typeof StreamEvent>;
// A lista de tipos de evento (constants.ts) tem que acompanhar o schema.
STREAM_EVENT_TYPES satisfies readonly StreamEvent['type'][];

// --- Board, copiloto, métricas e auditoria ------------------------------------------------------

export const Backlog = z.object({ epics: z.array(Epic), stories: z.array(UserStory) });
export type Backlog = z.infer<typeof Backlog>;

/** Para onde uma pessoa pode mover um card. Aprovar e rejeitar têm rota própria. */
export const MoveStoryRequest = z.object({ status: z.enum(['ready', 'in_progress', 'done']) });
export type MoveStoryRequest = z.infer<typeof MoveStoryRequest>;

export const ApprovalRequest = z.object({ approvedBy: z.string().trim().min(1).max(80).default('pessoa revisora') });
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

export const ChatRequest = z.object({ question: z.string().trim().min(3).max(2_000) });
export type ChatRequest = z.infer<typeof ChatRequest>;

export const ChatResponse = z.object({ answer: z.string(), sources: z.array(SearchHit) });
export type ChatResponse = z.infer<typeof ChatResponse>;

export const SessionMetrics = z.object({
  llmCalls: z.number().int(),
  cacheHits: z.number().int(),
  tokensIn: z.number().int(),
  tokensOut: z.number().int(),
  avgLatencyMs: z.number(),
  estimatedCostUsd: z.number(),
  /** `true` no modo mock: o custo é o de tabela de um modelo de referência, não uma cobrança. */
  costIsReference: z.boolean(),
  /** Quem está respondendo: openai, gemini, openrouter ou mock. */
  provider: z.string(),
  /** Onde os dados vivem: postgres ou memory (Postgres embutido, zerado a cada subida). */
  store: z.enum(['postgres', 'memory']),
  cache: z.enum(['redis', 'memory']),
});
export type SessionMetrics = z.infer<typeof SessionMetrics>;

export const AuditLog = z.object({
  id: z.string(),
  at: z.string(),
  /** Quem agiu: um agente do workflow, uma pessoa pelo board ou um cliente MCP. */
  actor: z.string(),
  action: z.string(),
  entityType: z.enum(['run', 'story', 'adr', 'document']),
  entityId: z.string(),
  details: z.record(z.string(), z.unknown()),
});
export type AuditLog = z.infer<typeof AuditLog>;
