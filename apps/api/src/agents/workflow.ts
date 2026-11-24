import type { RunnableConfig } from '@langchain/core/runnables';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { Adr, AgentName, GuardrailReport, SearchHit, StreamEvent } from '@specpilot/shared-schemas';
import type { Llm } from '../llm/llm.js';
import type { KnowledgeBase } from '../rag/knowledge-base.js';
import { reviewArchitecture } from './architect-reviewer.js';
import { retrieveContext } from './context-retriever.js';
import { type GatedBacklog, gateBacklog } from './human-approval-gate.js';
import { analyzeNotes } from './product-analyst.js';
import type { AnalystOutput, ReviewerOutput } from './schemas.js';

// O workflow multiagente, como um grafo do LangGraph. Quatro nós em sequência, e um estado
// tipado que cada nó lê e completa:
//
//   context_retriever → product_analyst → architect_reviewer → human_approval_gate
//
// Cada agente vê só o que precisa: o analista não recebe a lista de ADRs, o revisor não
// reescreve histórias, e o gate não chama modelo. Nada é gravado aqui: o grafo devolve o
// backlog já com o status de cada item, e quem persiste é o serviço (services.ts).

const WorkflowState = Annotation.Root({
  notes: Annotation<string>,
  guardrail: Annotation<GuardrailReport>,
  context: Annotation<SearchHit[]>,
  acceptedAdrs: Annotation<Adr[]>,
  analysis: Annotation<AnalystOutput>,
  review: Annotation<ReviewerOutput>,
  gated: Annotation<GatedBacklog>,
});
type State = typeof WorkflowState.State;

export type Emit = (event: StreamEvent) => void;

export interface WorkflowDeps {
  llm: Llm;
  knowledge: KnowledgeBase;
  listAcceptedAdrs: () => Promise<Adr[]>;
}

/** "1 conflito", "2 conflitos": o resumo de cada agente vai para a tela como está. */
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const countStories = (backlog: { epics: Array<{ stories: unknown[] }> }) =>
  backlog.epics.reduce((total, epic) => total + epic.stories.length, 0);

export function buildWorkflow(deps: WorkflowDeps) {
  /** Envolve um agente: avisa quando começa e quando termina, com um resumo do que fez. */
  const step =
    (agent: AgentName, run: (state: State) => Promise<{ update: Partial<State>; summary: string }>) =>
    async (state: State, config: RunnableConfig): Promise<Partial<State>> => {
      // O emissor chega por requisição, no `configurable`: o grafo é compilado uma vez só.
      const emit: Emit = config.configurable?.emit ?? (() => undefined);
      emit({ type: 'agent_started', agent });
      const start = performance.now();
      const { update, summary } = await run(state);
      emit({ type: 'agent_finished', agent, summary, durationMs: Math.round(performance.now() - start) });
      return update;
    };

  // Nome de nó não pode repetir nome de campo do estado: por isso os nós levam o nome do agente.
  return new StateGraph(WorkflowState)
    .addNode(
      'context_retriever',
      step('context_retriever', async (state) => {
        const retrieved = await retrieveContext(state.notes, deps);
        return {
          update: retrieved,
          summary: `${plural(retrieved.context.length, 'trecho', 'trechos')} da base e ${plural(retrieved.acceptedAdrs.length, 'ADR aceito', 'ADRs aceitos')}.`,
        };
      }),
    )
    .addNode(
      'product_analyst',
      step('product_analyst', async (state) => {
        const analysis = await analyzeNotes(state.notes, state.context, deps.llm);
        return {
          update: { analysis },
          summary: `${plural(analysis.epics.length, 'épico', 'épicos')} e ${plural(countStories(analysis), 'história', 'histórias')} com critérios em Gherkin.`,
        };
      }),
    )
    .addNode(
      'architect_reviewer',
      step('architect_reviewer', async (state) => {
        const titles = state.analysis.epics.flatMap((epic) => epic.stories.map((story) => story.title));
        const review = await reviewArchitecture(state.notes, state.acceptedAdrs, titles, deps.llm);
        return {
          update: { review },
          summary: `${plural(review.conflicts.length, 'conflito', 'conflitos')} com ADRs e ${plural(review.proposedAdrs.length, 'ADR proposto', 'ADRs propostos')}.`,
        };
      }),
    )
    .addNode(
      'human_approval_gate',
      step('human_approval_gate', async (state) => {
        const gated = gateBacklog(state.analysis, state.review, state.guardrail);
        const pending = gated.epics
          .flatMap((epic) => epic.stories)
          .filter((story) => story.status === 'pending_approval');
        return {
          update: { gated },
          summary: `${pending.length} de ${plural(countStories(gated), 'história espera', 'histórias esperam')} aprovação humana.`,
        };
      }),
    )
    .addEdge(START, 'context_retriever')
    .addEdge('context_retriever', 'product_analyst')
    .addEdge('product_analyst', 'architect_reviewer')
    .addEdge('architect_reviewer', 'human_approval_gate')
    .addEdge('human_approval_gate', END)
    .compile();
}

export type Workflow = ReturnType<typeof buildWorkflow>;
