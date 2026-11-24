import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approvalReasons, GATE_POLICY, gateBacklog } from './human-approval-gate.js';
import type { AnalystOutput, ReviewerOutput } from './schemas.js';

type Story = AnalystOutput['epics'][number]['stories'][number];

const CLEAN = { flagged: false, reasons: [] };
const NO_REVIEW: ReviewerOutput = { conflicts: [], proposedAdrs: [] };

/** Uma história que passa direto: impacto médio e confiança alta. Cada teste mexe em um campo. */
const story = (overrides: Partial<Story> = {}): Story => ({
  title: 'Exportar relatório em CSV',
  asA: 'gestor',
  iWant: 'exportar o relatório em CSV',
  soThat: 'eu analise os números',
  acceptanceCriteria: [{ scenario: 'ok', given: 'a', when: 'b', then: 'c' }],
  priority: 'medium',
  impact: 'medium',
  confidence: 0.9,
  ...overrides,
});

test('história de impacto médio e confiança alta vai direto para ready', () => {
  assert.deepEqual(approvalReasons(story(), NO_REVIEW, CLEAN), []);
  assert.deepEqual(approvalReasons(story({ impact: 'low', priority: 'high' }), NO_REVIEW, CLEAN), []);
});

test('alto impacto espera aprovação, por maior que seja a confiança', () => {
  assert.deepEqual(approvalReasons(story({ impact: 'high', confidence: 1 }), NO_REVIEW, CLEAN), [
    'Impacto alto: errar aqui custa caro.',
  ]);
});

test('confiança abaixo do corte espera aprovação; no corte, não', () => {
  assert.equal(GATE_POLICY.minConfidence, 0.7);
  assert.deepEqual(approvalReasons(story({ confidence: 0.69 }), NO_REVIEW, CLEAN), [
    'Confiança de 69%, abaixo de 70%.',
  ]);
  assert.deepEqual(approvalReasons(story({ confidence: 0.7 }), NO_REVIEW, CLEAN), []);
});

test('conflito com ADR segura só as histórias que dependem da decisão', () => {
  const review: ReviewerOutput = {
    conflicts: [
      {
        adrNumber: 1,
        description: 'MongoDB × PostgreSQL',
        severity: 'high',
        affectedStories: ['exportar relatório em csv '],
      },
    ],
    proposedAdrs: [],
  };
  // O título é comparado sem caixa e sem espaço nas pontas.
  assert.deepEqual(approvalReasons(story(), review, CLEAN), ['Depende de decisão em conflito com o ADR-001.']);
  assert.deepEqual(approvalReasons(story({ title: 'Outra história' }), review, CLEAN), []);
});

test('nota com cara de prompt injection segura tudo o que saiu dela', () => {
  const flagged = { flagged: true, reasons: ['pede para ignorar as instruções', 'tenta pular a aprovação humana'] };
  assert.deepEqual(approvalReasons(story(), NO_REVIEW, flagged), [
    'A nota de origem pede para ignorar as instruções e tenta pular a aprovação humana.',
  ]);
});

test('os motivos se acumulam, e gateBacklog marca o status de cada história', () => {
  const analysis: AnalystOutput = {
    epics: [
      {
        title: 'Épico',
        summary: 'Resumo',
        stories: [story(), story({ title: 'Pagar com PIX', impact: 'high', confidence: 0.5 })],
      },
    ],
  };
  const gated = gateBacklog(analysis, NO_REVIEW, CLEAN);

  assert.deepEqual(
    gated.epics[0]?.stories.map(({ title, status, approvalReasons: reasons }) => [title, status, reasons.length]),
    [
      ['Exportar relatório em CSV', 'ready', 0],
      ['Pagar com PIX', 'pending_approval', 2],
    ],
  );
  assert.equal(gated.epics[0]?.title, 'Épico');
});
