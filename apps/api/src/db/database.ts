import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

// Uma interface, dois bancos:
//
//   postgres   com DATABASE_URL: o Postgres 16 + pgvector do docker-compose
//   memory     sem DATABASE_URL: PGlite, um Postgres de verdade compilado para WebAssembly,
//              rodando dentro do processo e zerado a cada subida
//
// O modo sem configuração não é uma segunda implementação da busca: é o MESMO SQL, com
// pgvector e full-text search, só que embutido. O que roda na avaliação é o que roda em produção.

export interface Database {
  readonly kind: 'postgres' | 'memory';
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

const SCHEMA_FILE = join(import.meta.dirname, '../../../../infra/init.sql');

async function connectPostgres(url: string): Promise<Database> {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  // Sem parâmetros o driver usa o protocolo simples, que aceita o arquivo inteiro de uma vez.
  await pool.query(await readFile(SCHEMA_FILE, 'utf8'));
  return {
    kind: 'postgres',
    query: async <T>(sql: string, params?: unknown[]) => {
      const result = await pool.query(sql, params);
      return { rows: result.rows as T[] };
    },
    close: () => pool.end(),
  };
}

async function embeddedPostgres(): Promise<Database> {
  // Import dinâmico: quem usa o Postgres do docker-compose não carrega o WebAssembly.
  const [{ PGlite }, { vector }] = await Promise.all([
    import('@electric-sql/pglite'),
    import('@electric-sql/pglite-pgvector'),
  ]);
  const db = await PGlite.create({ extensions: { vector } });
  await db.exec(await readFile(SCHEMA_FILE, 'utf8'));
  return {
    kind: 'memory',
    query: async <T>(sql: string, params?: unknown[]) => {
      const result = await db.query<T>(sql, params);
      return { rows: result.rows };
    },
    close: () => db.close(),
  };
}

/** Abre o banco e aplica `infra/init.sql`, que é idempotente. */
export function openDatabase(databaseUrl: string | undefined): Promise<Database> {
  return databaseUrl ? connectPostgres(databaseUrl) : embeddedPostgres();
}
