import { adrLabel, type GuardrailReport, type Level, type StoryStatus } from '@specpilot/shared-schemas';
import type { AnalystOutput, ReviewerOutput } from './schemas.js';

// HumanApprovalGate: decide, EM CÓDIGO, o que a IA pode pôr direto no board e o que espera
// uma pessoa. Não há prompt aqui: uma regra que protege o backlog não pode depender de o
// modelo concordar com ela.

// PONTO DE EXTENSÃO: os cortes do gate.
export const GATE_POLICY = {
  /** Abaixo disto, a história precisa de alguém para confirmar o que o agente supôs. */
  minConfidence: 0.7,
} as const;

type AnalyzedStory = AnalystOutput['epics'][number]['stories'][number];

export interface GatedStory extends AnalyzedStory {
  status: Extract<StoryStatus, 'pending_approval' | 'ready'>;
  approvalReasons: string[];
}

export interface GatedBacklog {
  epics: Array<{ title: string; summary: string; stories: GatedStory[] }>;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const LEVEL: Record<Level, string> = { high: 'alto', medium: 'médio', low: 'baixo' };

/** Por que esta história não pode ir direto para o board. Lista vazia: pode. */
export function approvalReasons(story: AnalyzedStory, review: ReviewerOutput, guardrail: GuardrailReport): string[] {
  const reasons: string[] = [];
  if (story.impact === 'high') reasons.push(`Impacto ${LEVEL[story.impact]}: errar aqui custa caro.`);
  if (story.confidence < GATE_POLICY.minConfidence) {
    reasons.push(`Confiança de ${Math.round(story.confidence * 100)}%, abaixo de ${GATE_POLICY.minConfidence * 100}%.`);
  }
  for (const conflict of review.conflicts) {
    if (conflict.affectedStories.some((title) => same(title, story.title))) {
      reasons.push(`Depende de decisão em conflito com o ${adrLabel(conflict.adrNumber)}.`);
    }
  }
  // Nota com cara de prompt injection: nada do que saiu dela entra sem revisão.
  if (guardrail.flagged) reasons.push(`A nota de origem ${guardrail.reasons.join(' e ')}.`);
  return reasons;
}

export function gateBacklog(analysis: AnalystOutput, review: ReviewerOutput, guardrail: GuardrailReport): GatedBacklog {
  return {
    epics: analysis.epics.map((epic) => ({
      title: epic.title,
      summary: epic.summary,
      stories: epic.stories.map((story) => {
        const reasons = approvalReasons(story, review, guardrail);
        return { ...story, status: reasons.length > 0 ? 'pending_approval' : 'ready', approvalReasons: reasons };
      }),
    })),
  };
}
