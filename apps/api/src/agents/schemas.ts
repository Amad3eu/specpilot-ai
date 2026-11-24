import { AcceptanceCriterion, Level } from '@specpilot/shared-schemas';
import { z } from 'zod';

// O que os agentes pedem ao modelo. São schemas de SAÍDA DE LLM, e por isso sem `.optional()`
// e sem limite numérico: o modo estrito dos provedores exige todo campo e recusa parte das
// restrições. Faixa de valor e lista vazia são conferidas em código, depois da resposta.

export const AnalystOutput = z.object({
  epics: z.array(
    z.object({
      title: z.string(),
      summary: z.string(),
      stories: z.array(
        z.object({
          title: z.string(),
          asA: z.string(),
          iWant: z.string(),
          soThat: z.string(),
          acceptanceCriteria: z.array(AcceptanceCriterion),
          priority: Level,
          impact: Level,
          /** De 0 a 1: quanto a nota sustenta esta história. */
          confidence: z.number(),
        }),
      ),
    }),
  ),
});
export type AnalystOutput = z.infer<typeof AnalystOutput>;

export const ReviewerOutput = z.object({
  conflicts: z.array(
    z.object({
      /** Número do ADR aceito com o qual a nota bate de frente. */
      adrNumber: z.number().int(),
      description: z.string(),
      severity: Level,
      /** Títulos das histórias que dependem da decisão em conflito. Vazio: nenhuma. */
      affectedStories: z.array(z.string()),
    }),
  ),
  proposedAdrs: z.array(
    z.object({
      title: z.string(),
      context: z.string(),
      decision: z.string(),
      consequences: z.string(),
    }),
  ),
});
export type ReviewerOutput = z.infer<typeof ReviewerOutput>;
