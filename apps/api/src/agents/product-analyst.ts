import type { SearchHit } from '@specpilot/shared-schemas';
import type { Llm } from '../llm/llm.js';
import { ANALYST_SYSTEM, analystPrompt } from './prompts.js';
import { AnalystOutput } from './schemas.js';

// ProductAnalystAgent: da nota de reunião aos épicos e histórias, com critérios em Gherkin.
// A saída do modelo já chega validada pelo schema; aqui entra o que o schema não garante.

export async function analyzeNotes(notes: string, context: SearchHit[], llm: Llm): Promise<AnalystOutput> {
  const output = await llm.generateObject({
    system: ANALYST_SYSTEM,
    prompt: analystPrompt(notes, context),
    schema: AnalystOutput,
    schemaName: 'backlog_analysis',
    tier: 'balanced',
    label: 'agent:product_analyst',
  });

  return {
    epics: output.epics
      .map((epic) => ({
        ...epic,
        stories: epic.stories
          // História sem critério de aceite não é testável: não entra no backlog.
          .filter((story) => story.title.trim() && story.acceptanceCriteria.length > 0)
          // O schema de saída não limita o número: a faixa de 0 a 1 é garantida aqui.
          .map((story) => ({ ...story, confidence: Math.min(1, Math.max(0, story.confidence)) })),
      }))
      .filter((epic) => epic.stories.length > 0),
  };
}
