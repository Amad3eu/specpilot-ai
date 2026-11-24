import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { memoryCache } from './cache.js';
import { type ChatParams, createLlm, type Provider, providersFromEnv } from './llm.js';
import { createMetrics } from './metrics.js';
import { mockProvider } from './mock-provider.js';

const Answer = z.object({ value: z.number() });
const REQUEST = { system: 'sistema', prompt: 'pergunta', tier: 'fast', label: 'teste' } as const;

/** Um provedor falso que devolve as respostas da fila, na ordem, e guarda o que recebeu. */
function scripted(name: Provider['name'], replies: Array<string | Error>) {
  const calls: ChatParams[] = [];
  const provider: Provider = {
    name,
    async chat(params) {
      calls.push(params);
      const reply = replies.shift();
      if (reply === undefined) throw new Error('fila de respostas vazia');
      if (reply instanceof Error) throw reply;
      return { text: reply, tokensIn: 10, tokensOut: 5 };
    },
    async embed(texts) {
      return { vectors: texts.map(() => [1, 0]), tokensIn: texts.length };
    },
  };
  return { provider, calls };
}

const llmWith = (...providers: Provider[]) => {
  const metrics = createMetrics();
  return { llm: createLlm({ providers, cache: memoryCache(), metrics }), metrics };
};

test('generateObject devolve o objeto validado, mesmo com o JSON embrulhado em bloco de código', async () => {
  const { provider, calls } = scripted('openai', ['```json\n{"value": 42}\n```']);
  const { llm } = llmWith(provider);

  assert.deepEqual(await llm.generateObject({ ...REQUEST, schema: Answer, schemaName: 'answer' }), { value: 42 });
  assert.equal(calls[0]?.jsonSchema?.name, 'answer');
  assert.equal(calls[0]?.model, 'gpt-6-luna');
});

test('generateObject devolve o erro de validação ao modelo uma vez antes de desistir', async () => {
  const { provider, calls } = scripted('openai', ['{"value": "texto"}', '{"value": 7}']);
  const { llm } = llmWith(provider);

  assert.deepEqual(await llm.generateObject({ ...REQUEST, schema: Answer, schemaName: 'answer' }), { value: 7 });
  assert.equal(calls.length, 2);
  assert.match(calls[1]?.messages.at(-1)?.content ?? '', /não passou na validação/);

  const stubborn = scripted('openai', ['nada de JSON', 'ainda não']);
  await assert.rejects(
    llmWith(stubborn.provider).llm.generateObject({ ...REQUEST, schema: Answer, schemaName: 'answer' }),
    /Todos os provedores falharam/,
  );
});

test('fallback: quando um provedor falha, o seguinte responde no modelo dele', async () => {
  const down = scripted('openai', [new Error('HTTP 503')]);
  const up = scripted('gemini', ['{"value": 1}']);
  const { llm } = llmWith(down.provider, up.provider);

  assert.deepEqual(await llm.generateObject({ ...REQUEST, schema: Answer, schemaName: 'answer' }), { value: 1 });
  assert.equal(llm.provider, 'openai');
  assert.equal(up.calls[0]?.model, 'gemini-3.5-flash-lite');
});

test('cache: a mesma pergunta não chama o modelo de novo, e uma pergunta diferente chama', async () => {
  const { provider, calls } = scripted('openai', ['{"value": 1}', '{"value": 2}']);
  const { llm, metrics } = llmWith(provider);
  const ask = (prompt: string) => llm.generateObject({ ...REQUEST, prompt, schema: Answer, schemaName: 'answer' });

  assert.deepEqual(await ask('a'), { value: 1 });
  assert.deepEqual(await ask('a'), { value: 1 });
  assert.deepEqual(await ask('b'), { value: 2 });

  assert.equal(calls.length, 2);
  assert.deepEqual(
    [metrics.snapshot().llmCalls, metrics.snapshot().cacheHits, metrics.snapshot().tokensIn],
    [2, 1, 20],
  );
});

test('cache: entrada que não passa mais pelo schema é ignorada', async () => {
  const { provider } = scripted('openai', ['{"value": 1}', '{"value": 2, "extra": "x"}']);
  const { llm } = llmWith(provider);
  await llm.generateObject({ ...REQUEST, schema: Answer, schemaName: 'answer' });

  // O mesmo pedido, com um schema mais exigente: o que está no cache não serve.
  const Stricter = z.strictObject({ value: z.number(), extra: z.string() });
  assert.deepEqual(await llm.generateObject({ ...REQUEST, schema: Stricter, schemaName: 'answer' }), {
    value: 2,
    extra: 'x',
  });
});

test('generateText e embed passam pelas métricas, com custo estimado pela tabela', async () => {
  const { provider } = scripted('openai', ['olá']);
  const { llm, metrics } = llmWith(provider);

  assert.equal(await llm.generateText(REQUEST), 'olá');
  assert.deepEqual(await llm.embed(['a', 'b']), [
    [1, 0],
    [1, 0],
  ]);
  assert.equal(llm.embeddingModel, 'text-embedding-3-small');

  const usage = metrics.snapshot();
  assert.equal(usage.llmCalls, 2);
  // 10 tokens de entrada e 5 de saída no gpt-6-luna, mais 2 tokens de embedding.
  assert.ok(Math.abs(usage.estimatedCostUsd - (10 * 0.1 + 5 * 0.5 + 2 * 0.02) / 1_000_000) < 1e-15);
});

test('providersFromEnv: entra quem tem chave, na ordem; sem chave nenhuma, o mock', () => {
  const mock = mockProvider();
  const names = (env: NodeJS.ProcessEnv) => providersFromEnv(env, mock).map((provider) => provider.name);

  assert.deepEqual(names({}), ['mock']);
  assert.deepEqual(names({ GEMINI_API_KEY: 'chave' }), ['gemini']);
  assert.deepEqual(names({ OPENROUTER_API_KEY: 'c', OPENAI_API_KEY: 'a', GEMINI_API_KEY: 'b' }), [
    'openai',
    'gemini',
    'openrouter',
  ]);
  // O CI pede o mock pelo nome, mesmo que exista chave no ambiente.
  assert.deepEqual(names({ OPENAI_API_KEY: 'a', LLM_PROVIDERS: 'mock' }), ['mock']);
});
