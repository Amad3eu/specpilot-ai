-- Schema do SpecPilot. Idempotente: a API roda este arquivo toda vez que sobe, no Postgres
-- do docker-compose e no Postgres embutido (PGlite) do modo sem configuração.

CREATE EXTENSION IF NOT EXISTS vector;

-- Base de conhecimento ---------------------------------------------------------------------------

-- Um documento é a unidade indexada: um ADR, uma regra do projeto, um documento solto.
CREATE TABLE IF NOT EXISTS documents (
  id         TEXT        PRIMARY KEY,
  kind       TEXT        NOT NULL CHECK (kind IN ('adr', 'rule', 'doc')),
  title      TEXT        NOT NULL,
  content    TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Um chunk é o trecho que a busca devolve. Cada um carrega os dois índices da busca híbrida.
CREATE TABLE IF NOT EXISTS chunks (
  id              BIGSERIAL PRIMARY KEY,
  document_id     TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  chunk_index     INT  NOT NULL,
  -- O título do documento, repetido em cada chunk: é onde mora o termo exato ("ADR-003").
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,

  -- 1536 = text-embedding-3-small. Tem que bater com EMBEDDING_DIMENSIONS em
  -- apps/api/src/llm/models.ts.
  embedding       vector(1536) NOT NULL,

  -- Vetores de modelos diferentes não são comparáveis: a busca filtra por esta coluna.
  embedding_model TEXT NOT NULL,

  -- Mantida pelo banco: a aplicação nunca esquece de atualizar o índice lexical.
  -- Termo no título (peso A) vale mais do que no corpo (peso B).
  -- O idioma tem que bater com o da consulta em apps/api/src/rag/knowledge-base.ts.
  content_tsv     tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('portuguese', title), 'A') || setweight(to_tsvector('portuguese', content), 'B')
  ) STORED,

  UNIQUE (document_id, chunk_index)
);

-- Busca semântica: vizinhos aproximados por distância de cosseno.
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw ON chunks USING hnsw (embedding vector_cosine_ops);

-- Busca lexical: full-text search.
CREATE INDEX IF NOT EXISTS chunks_content_tsv_gin ON chunks USING gin (content_tsv);

-- Backlog ----------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS epics (
  id         TEXT        PRIMARY KEY,
  title      TEXT        NOT NULL,
  summary    TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stories (
  id                  TEXT        PRIMARY KEY,
  epic_id             TEXT        NOT NULL REFERENCES epics (id) ON DELETE CASCADE,
  title               TEXT        NOT NULL,
  as_a                TEXT        NOT NULL,
  i_want              TEXT        NOT NULL,
  so_that             TEXT        NOT NULL,
  -- Lista de cenários Gherkin: [{ scenario, given, when, then }].
  acceptance_criteria JSONB       NOT NULL,
  priority            TEXT        NOT NULL CHECK (priority IN ('high', 'medium', 'low')),
  impact              TEXT        NOT NULL CHECK (impact IN ('high', 'medium', 'low')),
  confidence          REAL        NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  -- As quatro colunas do board, mais 'rejected'. Item gerado por IA de alto impacto ou
  -- baixa confiança nasce em 'pending_approval' e só uma pessoa tira de lá.
  status              TEXT        NOT NULL CHECK (status IN ('pending_approval', 'ready', 'in_progress', 'done', 'rejected')),
  approval_reasons    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  approved_by         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stories_status ON stories (status);

-- Architecture Decision Records ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS adrs (
  id           TEXT        PRIMARY KEY,
  number       INT         NOT NULL UNIQUE,
  title        TEXT        NOT NULL,
  -- ADR sugerido por IA nasce 'proposed'. Só o aceito entra na base de conhecimento.
  status       TEXT        NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected')),
  context      TEXT        NOT NULL,
  decision     TEXT        NOT NULL,
  consequences TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Trilha de auditoria ----------------------------------------------------------------------------

-- Só recebe INSERT: quem agiu (agente, pessoa ou cliente MCP), o que fez e sobre o quê.
CREATE TABLE IF NOT EXISTS audit_trail (
  id          BIGSERIAL   PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor       TEXT        NOT NULL,
  action      TEXT        NOT NULL,
  entity_type TEXT        NOT NULL CHECK (entity_type IN ('run', 'story', 'adr', 'document')),
  entity_id   TEXT        NOT NULL,
  details     JSONB       NOT NULL DEFAULT '{}'::jsonb
);
