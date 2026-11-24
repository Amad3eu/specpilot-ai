import type { Adr } from '@specpilot/shared-schemas';
import type { Llm } from '../llm/llm.js';
import { REVIEWER_SYSTEM, reviewerPrompt } from './prompts.js';
import { ReviewerOutput } from './schemas.js';

// ArchitectReviewerAgent: confronta as decisões técnicas da reunião com os ADRs aceitos e
// propõe um ADR novo para o que ninguém decidiu ainda.

export async function reviewArchitecture(
  notes: string,
  acceptedAdrs: Adr[],
  storyTitles: string[],
  llm: Llm,
): Promise<ReviewerOutput> {
  const output = await llm.generateObject({
    system: REVIEWER_SYSTEM,
    prompt: reviewerPrompt(notes, acceptedAdrs, storyTitles),
    schema: ReviewerOutput,
    schemaName: 'architecture_review',
    tier: 'balanced',
    label: 'agent:architect_reviewer',
  });

  const known = new Set(acceptedAdrs.map((adr) => adr.number));
  return {
    // O modelo pode citar um ADR que não existe: conflito com número inventado é descartado.
    conflicts: output.conflicts.filter((conflict) => known.has(conflict.adrNumber)),
    proposedAdrs: output.proposedAdrs.filter((adr) => adr.title.trim() && adr.decision.trim()),
  };
}
