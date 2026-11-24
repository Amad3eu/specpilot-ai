import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Adr } from '@specpilot/shared-schemas';
import type { Llm } from '../llm/llm.js';
import { reviewArchitecture } from './architect-reviewer.js';
import { analyzeNotes } from './product-analyst.js';
import type { AnalystOutput, ReviewerOutput } from './schemas.js';

// O que os agentes garantem DEPOIS da resposta do modelo. O schema de saída não limita número
// nem exige lista com item (o modo estrito dos provedores recusa), então a conferência é em
// código. Um modelo falso devolve exatamente o que cada teste quer ver tratado.

const llmAnswering = (output: unknown): Llm => ({
  provider: 'mock',
  embeddingModel: 'nenhum',
  generateText: async () => '',
  generateObject: async <T>() => output as T,
  embed: async () => [],
});

type Story = AnalystOutput['epics'][number]['stories'][number];
const story = (overrides: Partial<Story>): Story => ({
  title: 'Pagar com PIX',
  asA: 'cliente',
  iWant: 'pagar com PIX',
  soThat: 'eu conclua a compra',
  acceptanceCriteria: [{ scenario: 's', given: 'g', when: 'w', then: 't' }],
  priority: 'medium',
  impact: 'high',
  confidence: 0.8,
  ...overrides,
});

const adr = (number: number): Adr => ({
  id: `adr-${number}`,
  number,
  title: 'PostgreSQL como banco de dados padrão',
  status: 'accepted',
  context: '',
  decision: 'Todo serviço persiste em PostgreSQL.',
  consequences: '',
  createdAt: '',
});

test('analista: história sem critério de aceite ou sem título não entra no backlog', async () => {
  const output: AnalystOutput = {
    epics: [
      {
        title: 'Pagamentos',
        summary: '',
        stories: [story({}), story({ title: 'Sem critério', acceptanceCriteria: [] }), story({ title: '   ' })],
      },
    ],
  };
  const analysis = await analyzeNotes('nota', [], llmAnswering(output));

  assert.deepEqual(
    analysis.epics[0]?.stories.map(({ title }) => title),
    ['Pagar com PIX'],
  );
});

test('analista: épico que ficou sem história some, e a confiança fica entre 0 e 1', async () => {
  const output: AnalystOutput = {
    epics: [
      { title: 'Vazio', summary: '', stories: [story({ acceptanceCriteria: [] })] },
      {
        title: 'Pagamentos',
        summary: '',
        stories: [story({ confidence: 1.7 }), story({ title: 'Outra', confidence: -0.2 })],
      },
    ],
  };
  const analysis = await analyzeNotes('nota', [], llmAnswering(output));

  assert.deepEqual(
    analysis.epics.map(({ title }) => title),
    ['Pagamentos'],
  );
  assert.deepEqual(
    analysis.epics[0]?.stories.map(({ confidence }) => confidence),
    [1, 0],
  );
});

test('revisor: conflito com um ADR que não existe é descartado', async () => {
  const output: ReviewerOutput = {
    conflicts: [
      { adrNumber: 1, description: 'MongoDB contra PostgreSQL', severity: 'high', affectedStories: [] },
      { adrNumber: 99, description: 'ADR que o modelo inventou', severity: 'high', affectedStories: [] },
    ],
    proposedAdrs: [],
  };
  const review = await reviewArchitecture('nota', [adr(1)], [], llmAnswering(output));

  assert.deepEqual(
    review.conflicts.map(({ adrNumber }) => adrNumber),
    [1],
  );
});

test('revisor: ADR proposto sem título ou sem decisão não vai para a fila', async () => {
  const proposal = { title: 'Adotar Kafka', context: 'c', decision: 'Usar Kafka.', consequences: 'x' };
  const output: ReviewerOutput = {
    conflicts: [],
    proposedAdrs: [proposal, { ...proposal, title: '  ' }, { ...proposal, title: 'Sem decisão', decision: '' }],
  };
  const review = await reviewArchitecture('nota', [adr(1)], [], llmAnswering(output));

  assert.deepEqual(review.proposedAdrs, [proposal]);
});
