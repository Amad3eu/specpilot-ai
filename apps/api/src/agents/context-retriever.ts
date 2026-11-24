import type { Adr, SearchHit } from '@specpilot/shared-schemas';
import type { KnowledgeBase } from '../rag/knowledge-base.js';

// ContextRetrieverAgent: antes de qualquer modelo opinar, busca o que o projeto já decidiu.
// Não chama LLM de texto: é a busca híbrida (vetorial + lexical, com RRF) sobre ADRs e regras.

export interface RetrievedContext {
  /** Trechos da base de conhecimento relevantes para a nota. */
  context: SearchHit[];
  /** Os ADRs aceitos: o revisor de arquitetura compara a nota com todos, não só com os recuperados. */
  acceptedAdrs: Adr[];
}

/** Poucos trechos, os melhores: contexto demais dilui a instrução e encarece a chamada. */
const CONTEXT_LIMIT = 3;

export async function retrieveContext(
  notes: string,
  deps: { knowledge: KnowledgeBase; listAcceptedAdrs: () => Promise<Adr[]> },
): Promise<RetrievedContext> {
  const [context, acceptedAdrs] = await Promise.all([
    deps.knowledge.search(notes, CONTEXT_LIMIT),
    deps.listAcceptedAdrs(),
  ]);
  return { context, acceptedAdrs };
}
