import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildApp, createServices, type Services } from '@specpilot/api';
import { z } from 'zod';
import { createClient } from './client.js';
import { createSpecPilotServer } from './server.js';

// A ponte inteira, sem rede: um cliente MCP de verdade fala com o servidor por transporte
// em memória, e o servidor fala com a API do SpecPilot em processo (modo mock). É o caminho
// que um agente percorre numa IDE, do protocolo ao board.

const ToolResult = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string() })),
  isError: z.boolean().optional(),
});

const NOTES = `Ana (PO): O cliente precisa pagar com PIX no checkout, com confirmação em até 10 segundos.
Carla (Financeiro): O financeiro quer exportar o relatório de vendas em CSV toda segunda-feira.
Bruno (Dev): Vamos usar MongoDB para guardar o catálogo de produtos.`;

let services: Services;
let app: ReturnType<typeof buildApp>;
let mcp: Client;

before(async () => {
  services = await createServices({ env: {}, warn: () => undefined });
  app = buildApp(services);

  // O mesmo cliente de produção, com a API em processo no lugar do fetch.
  const server = createSpecPilotServer(
    createClient(async (method, path, body) => {
      const response = await app.inject({
        method,
        url: path,
        payload: body as object | undefined,
        headers: { 'x-specpilot-actor': 'mcp' },
      });
      return { status: response.statusCode, json: response.json() };
    }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  mcp = new Client({ name: 'teste', version: '0.1.0' });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
});

after(async () => {
  await mcp.close();
  await app.close();
  await services.close();
});

const callTool = async (name: string, args: Record<string, unknown>) => {
  const result = ToolResult.parse(await mcp.callTool({ name, arguments: args }));
  return { text: result.content.map((item) => item.text).join('\n'), isError: result.isError ?? false };
};
const readResource = async (uri: string) => {
  const { contents } = await mcp.readResource({ uri });
  const [content] = contents;
  return content && 'text' in content ? String(content.text) : '';
};
/** O id da história cujo título casa, lido da saída de list_backlog_stories. */
const storyId = async (title: RegExp) => {
  const { text } = await callTool('list_backlog_stories', {});
  const line = text.split('\n').find((candidate) => title.test(candidate));
  const id = /id: ([\w-]+)/.exec(line ?? '')?.[1];
  assert.ok(id, `nenhuma história com ${title} em:\n${text}`);
  return id;
};

test('o servidor expõe as quatro tools e os dois resources do SpecPilot', async () => {
  const { tools } = await mcp.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    'approve_story',
    'ingest_meeting_notes',
    'list_backlog_stories',
    'search_architecture_docs',
  ]);
  // Quem só lê diz que só lê: o cliente pode liberar essas tools sem pedir confirmação.
  const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint).map((tool) => tool.name);
  assert.deepEqual(readOnly.sort(), ['list_backlog_stories', 'search_architecture_docs']);

  const { resources } = await mcp.listResources();
  assert.deepEqual(resources.map((resource) => resource.uri).sort(), [
    'specpilot://adrs/index',
    'specpilot://backlog/summary',
  ]);
});

test('ingest_meeting_notes: a nota vira histórias no backlog, com o conflito e o ADR proposto', async () => {
  const { text, isError } = await callTool('ingest_meeting_notes', { notes: NOTES });

  assert.equal(isError, false);
  assert.match(text, /^2 histórias criadas em 2 épicos\./);
  assert.match(text, /\[aguardando aprovação\] Pagar com PIX no checkout/);
  assert.match(text, /\[pronta\] Exportar o relatório de vendas em CSV/);
  assert.match(text, /Conflito com ADR-001 \(PostgreSQL como banco de dados padrão\)/);
  assert.match(text, /ADR proposto, aguardando decisão: ADR-004 Trocar PostgreSQL por MongoDB/);
});

test('list_backlog_stories: lista com id e status, e filtra por status', async () => {
  const all = await callTool('list_backlog_stories', {});
  assert.equal(all.text.split('\n').length, 2);

  const pending = await callTool('list_backlog_stories', { status: 'pending_approval' });
  assert.match(
    pending.text,
    /^- \[aguardando aprovação\] Pagar com PIX no checkout \(id: [\w-]+; prioridade medium, impacto high\)$/,
  );
  assert.equal((await callTool('list_backlog_stories', { status: 'done' })).text, 'Nenhuma história com esse filtro.');
});

test('approve_story: aprova em nome de uma pessoa, e a aprovação aparece no board e na auditoria', async () => {
  const id = await storyId(/PIX/);
  const approved = await callTool('approve_story', { storyId: id, approvedBy: 'Ana' });
  assert.equal(approved.text, 'Aprovada por Ana: "Pagar com PIX no checkout" agora está pronta.');

  // O board, lido pela API, vê o que o agente fez por MCP.
  const story = (await services.getBacklog()).stories.find((candidate) => candidate.id === id);
  assert.deepEqual([story?.status, story?.approvedBy], ['ready', 'Ana']);
  const entry = (await services.listAudit()).find((log) => log.action === 'story.approved');
  assert.deepEqual([entry?.actor, entry?.details.approvedBy], ['mcp', 'Ana']);
});

test('approve_story: o erro da API volta como resultado de tool, explicado', async () => {
  const again = await callTool('approve_story', { storyId: await storyId(/PIX/), approvedBy: 'Ana' });
  assert.equal(again.isError, true);
  assert.match(again.text, /Só uma história aguardando aprovação pode ser aprovada/);

  const unknown = await callTool('approve_story', { storyId: 'nao-existe', approvedBy: 'Ana' });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /não existe/);
});

test('search_architecture_docs: devolve o trecho do ADR que responde à pergunta', async () => {
  const { text } = await callTool('search_architecture_docs', { query: 'qual banco de dados usamos?', limit: 1 });
  assert.match(text, /^## ADR-001: PostgreSQL como banco de dados padrão \(adr\)\n/);
  assert.match(text, /Todo serviço persiste em PostgreSQL 16/);

  assert.equal(
    (await callTool('search_architecture_docs', { query: 'receita de bolo' })).text,
    'Nada na base de conhecimento sobre "receita de bolo".',
  );
});

test('resources: o resumo do backlog e o índice de ADRs refletem o estado atual', async () => {
  assert.match(
    await readResource('specpilot://backlog/summary'),
    /^Backlog com 2 histórias: 0 aguardando aprovação, 2 prontas, 0 em andamento, 0 concluídas\.$/,
  );

  const index = await readResource('specpilot://adrs/index');
  assert.match(index, /^# ADRs do projeto/);
  assert.match(index, /\*\*ADR-001: PostgreSQL como banco de dados padrão\*\* \(accepted\)/);
  assert.match(index, /\*\*ADR-004: Trocar PostgreSQL por MongoDB em banco de dados\*\* \(proposed\)/);
});

test('entrada fora do schema da tool é recusada antes de chegar à API', async () => {
  const short = await mcp.callTool({ name: 'ingest_meeting_notes', arguments: { notes: 'curta' } });
  assert.equal(short.isError, true);
});
