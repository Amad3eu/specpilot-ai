// Modelos e preços. PONTO DE EXTENSÃO: trocar de modelo é editar as duas tabelas abaixo.
// Ids e preços conferidos em 18/11/2026. Modelo novo sai toda semana: revise ao atualizar.

export type ProviderName = 'openai' | 'gemini' | 'openrouter' | 'mock';

/** O código pede uma faixa de capacidade, não um modelo: cada provedor traduz para o seu. */
export type ModelTier = 'fast' | 'balanced';

export interface ProviderModels {
  fast: string;
  balanced: string;
  embedding: string;
}

export const MODELS: Record<ProviderName, ProviderModels> = {
  openai: { fast: 'gpt-6-luna', balanced: 'gpt-6.1-terra', embedding: 'text-embedding-3-small' },
  gemini: { fast: 'gemini-3.5-flash-lite', balanced: 'gemini-4-hydrogen', embedding: 'gemini-embedding-001' },
  openrouter: {
    fast: 'openai/gpt-6-luna',
    balanced: 'openai/gpt-6.1-terra',
    embedding: 'openai/text-embedding-3-small',
  },
  mock: { fast: 'mock-fast', balanced: 'mock-balanced', embedding: 'mock-hash-embedding' },
};

/** Tem que bater com `vector(1536)` em infra/init.sql. */
export const EMBEDDING_DIMENSIONS = 1536;

/** USD por 1 milhão de tokens, preço de tabela. É estimativa: não cobre cache de prompt nem lote. */
const PRICE_PER_MILLION: Record<string, { input: number; output: number }> = {
  'gpt-6-luna': { input: 0.1, output: 0.5 },
  'gpt-6.1-terra': { input: 1, output: 5 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
  'gemini-4-hydrogen': { input: 1.5, output: 7.5 },
  'text-embedding-3-small': { input: 0.02, output: 0 },
  'gemini-embedding-001': { input: 0.15, output: 0 },
  // O mock não cobra nada. Para a barra de métricas não ficar zerada na avaliação, ele usa
  // o preço do modelo da OpenAI na mesma faixa, e a API marca o custo como "de referência".
  'mock-fast': { input: 0.1, output: 0.5 },
  'mock-balanced': { input: 1, output: 5 },
  'mock-hash-embedding': { input: 0.02, output: 0 },
};

/** Custo estimado de uma chamada. Modelo sem preço cadastrado custa zero. */
export function estimateCostUsd(model: string, tokensIn: number, tokensOut: number): number {
  // No OpenRouter o id vem com o fornecedor na frente: "openai/gpt-6-luna".
  const price = PRICE_PER_MILLION[model] ?? PRICE_PER_MILLION[model.slice(model.indexOf('/') + 1)];
  return price ? (tokensIn * price.input + tokensOut * price.output) / 1_000_000 : 0;
}
