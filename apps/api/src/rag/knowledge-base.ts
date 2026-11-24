import { randomUUID } from 'node:crypto';
import type { DocumentKind, KnowledgeDocument, SearchHit } from '@specpilot/shared-schemas';
import type { Database } from '../db/database.js';
import type { Llm } from '../llm/llm.js';

// Base de conhecimento com Hybrid RAG: cada chunk tem um embedding (pgvector) e um índice
// lexical (full-text search). A busca roda as duas e funde os rankings com RRF.
//
//   vetorial   acha o parecido no sentido, mesmo com outras palavras
//   lexical    acha o termo exato: "ADR-003", "PIX", um nome de tabela
//
// ADR e regra de projeto têm muito termo exato, e é por isso que só a vetorial não basta.

// PONTO DE EXTENSÃO: os cortes da busca.
const SEARCH = {
  /** Candidatos que cada busca entrega para a fusão. */
  candidates: 20,
  /** Constante do Reciprocal Rank Fusion. 60 é o valor do artigo original. */
  rrfK: 60,
  /**
   * Sem match lexical, o chunk só entra com pelo menos esta similaridade de cosseno. Sem o
   * piso, a busca vetorial sempre devolve "os mais próximos", por mais distantes que estejam.
   * Calibre com o seu modelo de embedding.
   */
  minSimilarity: 0.25,
} as const;

// `plainto_tsquery` junta os termos com E, e uma pergunta em linguagem natural quase nunca
// tem todas as palavras no mesmo chunk. Trocar o E por OU deixa o ranking decidir.
// O idioma tem que bater com a coluna gerada `content_tsv` em infra/init.sql.
// shortcut: full-text search do Postgres, não BM25. Para BM25 de verdade, uma extensão como pg_search.
const OR_TSQUERY = `replace(plainto_tsquery('portuguese', $1)::text, '&', '|')::tsquery`;

const MAX_CHUNK_CHARS = 800;

/** Quebra por parágrafo, juntando parágrafos curtos até o limite. Um ADR costuma caber em um chunk. */
export function chunkText(text: string, maxChars = MAX_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean)) {
    // Parágrafo maior que o limite é cortado em pedaços do tamanho do limite.
    const pieces =
      paragraph.length > maxChars ? (paragraph.match(new RegExp(`.{1,${maxChars}}`, 'gs')) ?? []) : [paragraph];
    for (const piece of pieces) {
      if (current && current.length + piece.length + 2 > maxChars) {
        chunks.push(current);
        current = '';
      }
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

const toVector = (embedding: number[]) => `[${embedding.join(',')}]`;

export type KnowledgeBase = ReturnType<typeof createKnowledgeBase>;

export function createKnowledgeBase(db: Database, llm: Llm) {
  /** Grava o documento e indexa os chunks. O título vai junto no embedding e no índice lexical de cada um. */
  async function indexDocument(input: {
    kind: DocumentKind;
    title: string;
    content: string;
  }): Promise<KnowledgeDocument> {
    const id = randomUUID();
    const chunks = chunkText(input.content);
    const embeddings = await llm.embed(chunks.map((chunk) => `${input.title}\n\n${chunk}`));

    const { rows } = await db.query<{ created_at: Date }>(
      'INSERT INTO documents (id, kind, title, content) VALUES ($1, $2, $3, $4) RETURNING created_at',
      [id, input.kind, input.title, input.content],
    );
    for (const [index, chunk] of chunks.entries()) {
      await db.query(
        `INSERT INTO chunks (document_id, chunk_index, title, content, embedding, embedding_model)
         VALUES ($1, $2, $3, $4, $5::vector, $6)`,
        [id, index, input.title, chunk, toVector(embeddings[index] ?? []), llm.embeddingModel],
      );
    }
    return { id, ...input, createdAt: new Date(rows[0]?.created_at ?? Date.now()).toISOString() };
  }

  /** Busca híbrida: vetorial e lexical, fundidas por RRF. Devolve o melhor trecho de cada documento. */
  async function search(query: string, limit = 5): Promise<SearchHit[]> {
    const [embedding] = await llm.embed([query]);
    // Palavra de uma ou duas letras ("é", "os") não é termo de busca, e o dicionário português
    // do Postgres deixa algumas passarem: com o OU da consulta, casariam com quase tudo.
    const terms = query
      .split(/\s+/)
      .filter((word) => word.replace(/[^\p{L}\p{N}]/gu, '').length > 2)
      .join(' ');
    const { rows } = await db.query<{
      document_id: string;
      kind: DocumentKind;
      title: string;
      snippet: string;
      score: number;
    }>(
      `WITH q AS (SELECT ${OR_TSQUERY} AS tsq),
       semantic AS (
         SELECT c.id, RANK() OVER (ORDER BY c.embedding <=> $2::vector) AS rank,
                1 - (c.embedding <=> $2::vector) AS similarity
         FROM chunks c
         WHERE c.embedding_model = $3
         ORDER BY c.embedding <=> $2::vector
         LIMIT $4
       ),
       keyword AS (
         SELECT c.id, RANK() OVER (ORDER BY ts_rank_cd(c.content_tsv, q.tsq) DESC) AS rank
         FROM q, chunks c
         WHERE c.content_tsv @@ q.tsq
         ORDER BY ts_rank_cd(c.content_tsv, q.tsq) DESC
         LIMIT $4
       )
       SELECT d.id AS document_id, d.kind, d.title, c.content AS snippet,
              (COALESCE(1.0 / ($5::int + s.rank), 0) + COALESCE(1.0 / ($5::int + kw.rank), 0))::float8 AS score
       FROM semantic s
       FULL OUTER JOIN keyword kw ON kw.id = s.id
       JOIN chunks c ON c.id = COALESCE(s.id, kw.id)
       JOIN documents d ON d.id = c.document_id
       WHERE kw.id IS NOT NULL OR s.similarity >= $6
       -- No empate do RRF, vale o ranking lexical: o termo exato decide.
       ORDER BY score DESC, kw.rank NULLS LAST, s.rank NULLS LAST`,
      [terms, toVector(embedding ?? []), llm.embeddingModel, SEARCH.candidates, SEARCH.rrfK, SEARCH.minSimilarity],
    );

    // Um documento longo pode trazer vários chunks: fica o de maior score de cada um.
    const best = new Map<string, SearchHit>();
    for (const row of rows) {
      if (best.has(row.document_id)) continue;
      best.set(row.document_id, {
        documentId: row.document_id,
        kind: row.kind,
        title: row.title,
        snippet: row.snippet,
        score: row.score,
      });
    }
    return [...best.values()].slice(0, limit);
  }

  async function list(): Promise<KnowledgeDocument[]> {
    const { rows } = await db.query<{
      id: string;
      kind: DocumentKind;
      title: string;
      content: string;
      created_at: Date;
    }>('SELECT id, kind, title, content, created_at FROM documents ORDER BY created_at DESC, title');
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      content: row.content,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  return { indexDocument, search, list };
}
