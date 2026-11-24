import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CacheStore } from './cache.js';
import type { Metrics } from './metrics.js';
import { EMBEDDING_DIMENSIONS, estimateCostUsd, MODELS, type ModelTier, type ProviderName } from './models.js';

// A única porta de saída para um modelo. Tudo o que é comum mora aqui: fallback entre
// provedores, saída estruturada validada com Zod, cache, custo e métricas. Os agentes pedem
// "um objeto neste schema" e não sabem qual provedor respondeu.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  /** Quando presente, pede saída JSON aderente a este JSON Schema. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  /** Rótulo do ponto de chamada, ex.: "agent:product_analyst". Chega ao provedor mock. */
  label: string;
}

/**
 * Contrato mínimo de um provedor. PONTO DE EXTENSÃO: um provedor que não fala o protocolo
 * da OpenAI (SDK da Anthropic, Bedrock, modelo servido por você) entra implementando isto.
 */
export interface Provider {
  readonly name: ProviderName;
  chat(params: ChatParams): Promise<{ text: string; tokensIn: number; tokensOut: number }>;
  embed(texts: string[]): Promise<{ vectors: number[][]; tokensIn: number }>;
}

export interface GenerateRequest {
  system: string;
  prompt: string;
  tier: ModelTier;
  label: string;
}

export interface ObjectRequest<T> extends GenerateRequest {
  schema: z.ZodType<T>;
  schemaName: string;
}

export interface Llm {
  /** O provedor principal: o primeiro da cadeia de fallback. */
  readonly provider: ProviderName;
  /** O modelo de embedding em uso. A busca filtra por ele: vetores de modelos diferentes não se comparam. */
  readonly embeddingModel: string;
  generateText(request: GenerateRequest): Promise<string>;
  /** Saída estruturada: o objeto devolvido já passou pelo schema Zod. */
  generateObject<T>(request: ObjectRequest<T>): Promise<T>;
  embed(texts: string[]): Promise<number[][]>;
}

/** OpenAI, Gemini e OpenRouter expõem o mesmo protocolo: muda a URL base e a chave. */
export function openAiCompatible(name: ProviderName, baseUrl: string, apiKey: string): Provider {
  const post = async (path: string, body: unknown): Promise<unknown> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    // O corpo do erro não entra na mensagem: pode ecoar o pedido, e a mensagem vai para o log.
    if (!response.ok) throw new Error(`${name} respondeu HTTP ${response.status} em ${path}`);
    return response.json();
  };

  const ChatResponse = z.object({
    choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
    usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).optional(),
  });
  const EmbeddingResponse = z.object({
    data: z.array(z.object({ embedding: z.array(z.number()) })),
    usage: z.object({ prompt_tokens: z.number() }).optional(),
  });

  return {
    name,
    async chat({ model, messages, jsonSchema }) {
      const response = ChatResponse.parse(
        await post('/chat/completions', {
          model,
          messages,
          // `strict` exige todo campo como obrigatório: nos schemas, `.nullable()`, não `.optional()`.
          response_format: jsonSchema
            ? { type: 'json_schema', json_schema: { ...jsonSchema, strict: true } }
            : undefined,
        }),
      );
      return {
        text: response.choices[0]?.message.content ?? '',
        tokensIn: response.usage?.prompt_tokens ?? 0,
        tokensOut: response.usage?.completion_tokens ?? 0,
      };
    },
    async embed(texts) {
      const response = EmbeddingResponse.parse(
        await post('/embeddings', {
          model: MODELS[name].embedding,
          input: texts,
          encoding_format: 'float',
          dimensions: EMBEDDING_DIMENSIONS,
        }),
      );
      return { vectors: response.data.map((item) => item.embedding), tokensIn: response.usage?.prompt_tokens ?? 0 };
    },
  };
}

const REAL_PROVIDERS = {
  openai: { key: 'OPENAI_API_KEY', baseUrl: 'https://api.openai.com/v1' },
  gemini: { key: 'GEMINI_API_KEY', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  openrouter: { key: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1' },
} as const;

/**
 * Monta a cadeia de fallback a partir do ambiente: entra quem tem chave, na ordem OpenAI,
 * Gemini, OpenRouter. Sem chave nenhuma (ou com LLM_PROVIDERS=mock), entra o provedor mock.
 */
export function providersFromEnv(env: NodeJS.ProcessEnv, mock: Provider): Provider[] {
  if (env.LLM_PROVIDERS?.trim().toLowerCase() === 'mock') return [mock];
  const providers = (Object.keys(REAL_PROVIDERS) as Array<keyof typeof REAL_PROVIDERS>).flatMap((name) => {
    const apiKey = env[REAL_PROVIDERS[name].key];
    return apiKey ? [openAiCompatible(name, REAL_PROVIDERS[name].baseUrl, apiKey)] : [];
  });
  return providers.length > 0 ? providers : [mock];
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // `$schema` é metadado do documento: alguns provedores recusam chave que não conhecem.
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(schema);
  return jsonSchema;
}

function parseStructured<T>(text: string, schema: z.ZodType<T>): { data: T } | { issues: string } {
  let json: unknown;
  try {
    // Modelo que ignora o `response_format` costuma embrulhar o JSON em bloco de código.
    json = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    return { issues: 'a resposta não é um JSON válido.' };
  }
  const result = schema.safeParse(json);
  return result.success ? { data: result.data } : { issues: z.prettifyError(result.error) };
}

/** Quantas vezes o erro de validação volta ao modelo antes de desistir do provedor. */
const MAX_REPAIR_ATTEMPTS = 1;
const CACHE_TTL_SECONDS = 60 * 60;

export interface LlmDeps {
  providers: Provider[];
  cache: CacheStore;
  metrics: Metrics;
  warn?: (message: string) => void;
}

export function createLlm({ providers, cache, metrics, warn = () => undefined }: LlmDeps): Llm {
  const [primary] = providers;
  if (!primary) throw new Error('createLlm: informe ao menos um provedor.');

  /** Uma chamada a um provedor, sempre medida. */
  const chat = async (provider: Provider, params: ChatParams): Promise<string> => {
    const start = performance.now();
    const { text, tokensIn, tokensOut } = await provider.chat(params);
    metrics.recordCall({
      latencyMs: performance.now() - start,
      tokensIn,
      tokensOut,
      costUsd: estimateCostUsd(params.model, tokensIn, tokensOut),
    });
    return text;
  };

  /** Tenta os provedores em ordem. Qualquer erro (rede, limite, validação) passa a vez. */
  const withFallback = async <R>(
    request: GenerateRequest,
    attempt: (provider: Provider, model: string) => Promise<R>,
  ): Promise<R> => {
    const errors: unknown[] = [];
    for (const provider of providers) {
      try {
        return await attempt(provider, MODELS[provider.name][request.tier]);
      } catch (error) {
        errors.push(error);
        warn(
          `[FALLBACK] ${provider.name} falhou em ${request.label}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
    throw new AggregateError(errors, `Todos os provedores falharam (${providers.map((p) => p.name).join(' → ')}).`);
  };

  /** Responde do cache quando a mesma pergunta já foi feita ao mesmo modelo. */
  const cached = async <R>(
    request: GenerateRequest,
    kind: string,
    decode: (raw: string) => R | undefined,
    compute: () => Promise<{ value: R; raw: string }>,
  ): Promise<R> => {
    const key = `specpilot:llm:${createHash('sha256')
      .update(JSON.stringify([primary.name, request.tier, kind, request.system, request.prompt]))
      .digest('hex')}`;
    const hit = await cache.get(key);
    const fromCache = hit === null ? undefined : decode(hit);
    if (fromCache !== undefined) {
      metrics.recordCacheHit();
      return fromCache;
    }
    const { value, raw } = await compute();
    await cache.set(key, raw, CACHE_TTL_SECONDS);
    return value;
  };

  return {
    provider: primary.name,
    embeddingModel: MODELS[primary.name].embedding,

    generateText: (request) =>
      cached(
        request,
        'text',
        (raw) => raw,
        async () => {
          const messages: ChatMessage[] = [
            { role: 'system', content: request.system },
            { role: 'user', content: request.prompt },
          ];
          const text = await withFallback(request, (provider, model) =>
            chat(provider, { model, messages, label: request.label }),
          );
          return { value: text, raw: text };
        },
      ),

    generateObject: <T>(request: ObjectRequest<T>) =>
      cached(
        request,
        `object:${request.schemaName}`,
        // O que está no cache passa pelo schema de novo: um schema que mudou invalida a entrada.
        (raw) => {
          const parsed = parseStructured(raw, request.schema);
          return 'data' in parsed ? parsed.data : undefined;
        },
        async () => {
          const jsonSchema = { name: request.schemaName, schema: toJsonSchema(request.schema) };
          return withFallback(request, async (provider, model) => {
            let messages: ChatMessage[] = [
              { role: 'system', content: request.system },
              { role: 'user', content: request.prompt },
            ];
            for (let repairs = 0; ; repairs++) {
              const text = await chat(provider, { model, messages, jsonSchema, label: request.label });
              const parsed = parseStructured(text, request.schema);
              if ('data' in parsed) return { value: parsed.data, raw: JSON.stringify(parsed.data) };
              if (repairs >= MAX_REPAIR_ATTEMPTS) {
                throw new Error(`A saída do modelo não passou na validação do schema:\n${parsed.issues}`);
              }
              // Devolve o erro ao modelo: a maior parte das falhas de schema se resolve aqui.
              messages = [
                ...messages,
                { role: 'assistant', content: text },
                {
                  role: 'user',
                  content: `Sua resposta anterior não passou na validação:\n${parsed.issues}\nResponda de novo, somente com o JSON corrigido.`,
                },
              ];
            }
          });
        },
      ),

    async embed(texts) {
      // Sem fallback de propósito: vetores de modelos diferentes vivem em espaços diferentes,
      // e misturá-los no mesmo índice estraga a busca sem dar erro nenhum.
      const start = performance.now();
      const { vectors, tokensIn } = await primary.embed(texts);
      metrics.recordCall({
        latencyMs: performance.now() - start,
        tokensIn,
        tokensOut: 0,
        costUsd: estimateCostUsd(MODELS[primary.name].embedding, tokensIn, 0),
      });
      return vectors;
    },
  };
}
