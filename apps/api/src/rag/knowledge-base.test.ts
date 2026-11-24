import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { type Database, openDatabase } from '../db/database.js';
import { memoryCache } from '../llm/cache.js';
import { createLlm } from '../llm/llm.js';
import { createMetrics } from '../llm/metrics.js';
import { mockProvider } from '../llm/mock-provider.js';
import { chunkText, createKnowledgeBase, type KnowledgeBase } from './knowledge-base.js';

// A busca roda no Postgres embutido, com o schema de infra/init.sql: é o mesmo SQL, com
// pgvector e full-text search, que roda no Postgres do docker-compose.

let db: Database;
let knowledge: KnowledgeBase;

before(async () => {
  db = await openDatabase(undefined);
  const llm = createLlm({ providers: [mockProvider()], cache: memoryCache(), metrics: createMetrics() });
  knowledge = createKnowledgeBase(db, llm);

  await knowledge.indexDocument({
    kind: 'adr',
    title: 'ADR-001: PostgreSQL como banco de dados padrão',
    content: 'Decisão: todo serviço persiste em PostgreSQL 16. Outro banco de dados só entra com um ADR novo.',
  });
  await knowledge.indexDocument({
    kind: 'adr',
    title: 'ADR-002: Autenticação por OAuth 2.0',
    content: 'Decisão: o login é delegado a um provedor OIDC central. Nenhum serviço guarda senha.',
  });
  await knowledge.indexDocument({
    kind: 'rule',
    title: 'Regra de pagamentos',
    content: 'Toda cobrança passa pelo gateway homologado. Pagamento por PIX precisa de confirmação por webhook.',
  });
});

after(() => db.close());

const titles = async (query: string) => (await knowledge.search(query)).map((hit) => hit.title);

test('chunkText junta parágrafos curtos e corta o que passa do limite', () => {
  assert.deepEqual(chunkText('um\n\ndois\n\ntrês', 100), ['um\n\ndois\n\ntrês']);
  assert.deepEqual(chunkText('aaaa\n\nbbbb\n\ncccc', 10), ['aaaa\n\nbbbb', 'cccc']);
  assert.deepEqual(chunkText('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  assert.deepEqual(chunkText('  \n\n  '), []);
});

test('o documento indexado volta na listagem, com o tipo e o conteúdo', async () => {
  const documents = await knowledge.list();
  assert.equal(documents.length, 3);
  assert.deepEqual(documents.map(({ kind }) => kind).sort(), ['adr', 'adr', 'rule']);
  assert.match(documents.find(({ kind }) => kind === 'rule')?.content ?? '', /gateway homologado/);
});

test('busca híbrida: a pergunta em linguagem natural acha o documento do assunto primeiro', async () => {
  assert.equal(
    (await titles('qual banco de dados os serviços usam?'))[0],
    'ADR-001: PostgreSQL como banco de dados padrão',
  );
  assert.equal((await titles('como funciona o login e a senha?'))[0], 'ADR-002: Autenticação por OAuth 2.0');
});

test('busca híbrida: o termo exato acha pelo lado lexical, e só o documento que o contém', async () => {
  assert.deepEqual(await titles('PIX'), ['Regra de pagamentos']);
  // O número do ADR só existe no título.
  assert.equal((await titles('ADR-002'))[0], 'ADR-002: Autenticação por OAuth 2.0');
});

test('busca híbrida: termo no título pesa mais do que no corpo', async () => {
  await knowledge.indexDocument({
    kind: 'doc',
    title: 'Manual de integração',
    content: 'A autenticação da integração usa a mesma regra dos outros serviços, descrita em outro documento.',
  });
  assert.equal((await titles('autenticação'))[0], 'ADR-002: Autenticação por OAuth 2.0');
});

test('busca híbrida: pergunta sem relação com a base não devolve os "menos distantes"', async () => {
  assert.deepEqual(await titles('receita de bolo de cenoura'), []);
  // Palavra de uma ou duas letras não vira termo de busca.
  assert.deepEqual(await titles('é o a de'), []);
});

test('o trecho devolvido é o conteúdo do chunk, com score e documento de origem', async () => {
  const [hit] = await knowledge.search('PIX');
  assert.equal(hit?.kind, 'rule');
  assert.match(hit?.snippet ?? '', /^Toda cobrança passa pelo gateway/);
  assert.ok((hit?.score ?? 0) > 0);
  assert.ok((await knowledge.list()).some((document) => document.id === hit?.documentId));
});

test('limite: a busca devolve no máximo o pedido, um trecho por documento', async () => {
  const hits = await knowledge.search('decisão serviço banco login', 2);
  assert.equal(hits.length, 2);
  assert.equal(new Set(hits.map((hit) => hit.documentId)).size, 2);
});
