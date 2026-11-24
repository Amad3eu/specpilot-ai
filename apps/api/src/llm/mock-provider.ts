import type { Provider } from './llm.js';
import { analyze, answer, review } from './mock-brain.js';
import { EMBEDDING_DIMENSIONS } from './models.js';

// Provedor determinístico e sem rede. Entra sozinho quando nenhuma chave está configurada,
// ou explicitamente com LLM_PROVIDERS=mock (é o que o CI usa). Quem clona o repositório roda
// a aplicação inteira, do workflow multiagente ao board, sem configurar nada.

/** Estimativa grosseira (≈4 caracteres por token), para as métricas não ficarem zeradas. */
const approxTokens = (text: string) => Math.ceil(text.length / 4);

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const STOPWORDS = new Set(
  'como para com que uma uns umas por dos das nos nas nao mais sao tem ser seu sua seus suas esta este isso essa esse aquele quando onde qual quais quanto sobre entre pelo pela ate sem mas foi sera cada todo toda todos todas muito tambem depois antes feita feito fazer faz'.split(
    ' ',
  ),
);

/**
 * Embedding determinístico por hashing de palavras ("hashing trick"): textos com palavras em
 * comum ficam próximos. Não entende sinônimo, mas exercita a busca vetorial de verdade.
 */
export function hashEmbedding(text: string, dimensions = EMBEDDING_DIMENSIONS): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const words =
    text
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .match(/[a-z0-9]{3,}/g) ?? [];
  for (const word of words) {
    // Palavra vazia aproximaria textos que não têm assunto em comum.
    if (STOPWORDS.has(word)) continue;
    const hash = fnv1a(word);
    const index = hash % dimensions;
    vector[index] = (vector[index] ?? 0) + (hash & 0x80000000 ? -1 : 1);
  }
  const norm = Math.hypot(...vector);
  // Texto sem palavras daria vetor nulo, que não tem distância de cosseno definida.
  return norm === 0 ? vector.with(0, 1) : vector.map((value) => value / norm);
}

/** O rótulo da chamada decide qual papel o mock faz. */
const ROLES: Record<string, (prompt: string) => unknown> = {
  'agent:product_analyst': analyze,
  'agent:architect_reviewer': review,
  'copilot:answer': answer,
};

export function mockProvider(): Provider {
  return {
    name: 'mock',
    async chat({ messages, label }) {
      const prompt = messages.findLast((message) => message.role === 'user')?.content ?? '';
      const output = ROLES[label]?.(prompt) ?? `[mock] ${prompt.slice(0, 160)}`;
      const text = typeof output === 'string' ? output : JSON.stringify(output);
      return {
        text,
        tokensIn: messages.reduce((total, message) => total + approxTokens(message.content), 0),
        tokensOut: approxTokens(text),
      };
    },
    async embed(texts) {
      return {
        vectors: texts.map((text) => hashEmbedding(text)),
        tokensIn: texts.reduce((total, text) => total + approxTokens(text), 0),
      };
    },
  };
}
