import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analystPrompt, copilotPrompt, reviewerPrompt } from '../agents/prompts.js';
import { AnalystOutput, ReviewerOutput } from '../agents/schemas.js';
import { analyze, answer, review } from './mock-brain.js';

const NOTES = `Reunião de planejamento do checkout
Ana (PO): O cliente precisa pagar com PIX no checkout, com confirmação em até 10 segundos.
Bruno (Dev): Vamos usar MongoDB para guardar o catálogo de produtos.
Carla (Financeiro): O financeiro quer exportar o relatório de vendas em CSV toda segunda-feira.
Ana (PO): Falta um aviso por e-mail quando o pagamento falhar, isso é urgente.
Diego (Suporte): Talvez criar um filtro de busca por categoria no catálogo, ver depois.
Bruno (Dev): Decidimos publicar eventos de pedido no Kafka.`;

const ADRS = [
  { id: 'a', number: 1, title: 'PostgreSQL como banco de dados padrão', status: 'accepted' as const },
  { id: 'b', number: 2, title: 'API REST com contrato OpenAPI', status: 'accepted' as const },
].map((adr) => ({ ...adr, context: '', decision: 'Decisão.', consequences: '', createdAt: '' }));

const stories = () => analyze(analystPrompt(NOTES, [])).epics.flatMap((epic) => epic.stories);
const story = (title: RegExp) => {
  const found = stories().find((candidate) => title.test(candidate.title));
  assert.ok(found, `nenhuma história com ${title}`);
  return found;
};

test('analyze: frase de requisito vira história; título de reunião e decisão técnica, não', () => {
  const output = analyze(analystPrompt(NOTES, []));

  assert.equal(AnalystOutput.safeParse(output).success, true);
  assert.deepEqual(
    stories().map(({ title }) => title),
    [
      'Pagar com PIX no checkout',
      'Exportar o relatório de vendas em CSV toda segunda-feira',
      'Um aviso por e-mail quando o pagamento falhar',
      'Criar um filtro de busca por categoria no catálogo',
    ],
  );
  assert.deepEqual(
    output.epics.map(({ title }) => title),
    ['Pagamentos e checkout', 'Relatórios e indicadores', 'Notificações e comunicação', 'Catálogo e busca'],
  );
});

test('analyze: persona, pedido e benefício saem da frase, sem o nome de quem falou', () => {
  const pix = story(/PIX/);
  assert.equal(pix.asA, 'cliente');
  assert.equal(pix.iWant, 'pagar com PIX no checkout, com confirmação em até 10 segundos');
  assert.equal(story(/relatório/).asA, 'pessoa do financeiro');

  const explicit = analyze(
    analystPrompt('Como gestor, quero ver o total de vendas do mês para que eu acompanhe a meta.', []),
  );
  assert.deepEqual(
    explicit.epics[0]?.stories.map(({ asA, iWant, soThat }) => [asA, iWant, soThat]),
    [['gestor', 'ver o total de vendas do mês', 'eu acompanhe a meta']],
  );
});

test('analyze: toda história tem dois cenários Gherkin completos', () => {
  for (const { acceptanceCriteria } of stories()) {
    assert.equal(acceptanceCriteria.length, 2);
    for (const criterion of acceptanceCriteria) {
      assert.ok(criterion.scenario && criterion.given && criterion.when && criterion.then);
    }
  }
  assert.equal(story(/PIX/).acceptanceCriteria[1]?.scenario, 'Pagamento não confirmado');
});

test('analyze: prioridade, impacto e confiança seguem o que a frase diz', () => {
  // Pagamento custa caro quando erra; relatório, não.
  assert.equal(story(/PIX/).impact, 'high');
  assert.equal(story(/relatório/).impact, 'low');
  // "isso é urgente" sobe a prioridade e sai do texto da história.
  assert.equal(story(/aviso/).priority, 'high');
  assert.doesNotMatch(story(/aviso/).iWant, /urgente/);
  // "Talvez ... ver depois": prioridade baixa e confiança baixa.
  const maybe = story(/filtro/);
  assert.equal(maybe.priority, 'low');
  assert.ok(maybe.confidence < 0.7);
  assert.ok(story(/PIX/).confidence > 0.8);
});

test('analyze: nota sem requisito devolve backlog vazio', () => {
  assert.deepEqual(analyze(analystPrompt('Reunião rápida, só alinhamento de agenda da semana que vem.', [])), {
    epics: [],
  });
});

test('review: decisão que contradiz um ADR aceito vira conflito e um ADR de troca', () => {
  const output = review(reviewerPrompt(NOTES, ADRS, ['Pagar com PIX no checkout']));

  assert.equal(ReviewerOutput.safeParse(output).success, true);
  assert.deepEqual(output.conflicts, [
    {
      adrNumber: 1,
      description: 'A reunião propõe MongoDB para banco de dados, e o ADR-001 define PostgreSQL.',
      severity: 'high',
      affectedStories: [],
    },
  ]);
  assert.deepEqual(
    output.proposedAdrs.map(({ title }) => title),
    ['Trocar PostgreSQL por MongoDB em banco de dados', 'Adotar Kafka para mensageria'],
  );
  assert.match(output.proposedAdrs[0]?.consequences ?? '', /rever o ADR-001/);
});

test('review: a história que cita a tecnologia em conflito fica marcada', () => {
  const notes = 'Vamos usar MongoDB no catálogo.\nO cliente precisa buscar produtos no MongoDB com filtro por preço.';
  const output = review(reviewerPrompt(notes, ADRS, ['Buscar produtos no MongoDB com filtro por preço', 'Outra']));
  assert.deepEqual(output.conflicts[0]?.affectedStories, ['Buscar produtos no MongoDB com filtro por preço']);
});

test('review: repetir o que o ADR já define não é conflito nem ADR novo', () => {
  const notes = 'Decidimos guardar os pedidos no PostgreSQL, como sempre.\nVamos usar REST na API de parceiros.';
  assert.deepEqual(review(reviewerPrompt(notes, ADRS, [])), { conflicts: [], proposedAdrs: [] });
  // Sem decisão técnica na nota, nada a revisar.
  assert.deepEqual(review(reviewerPrompt('O cliente precisa pagar com PIX no checkout.', ADRS, [])), {
    conflicts: [],
    proposedAdrs: [],
  });
});

test('answer: responde com a melhor fonte e cita o título; pergunta de backlog usa o resumo', () => {
  const hit = (title: string, snippet: string) => ({
    documentId: title,
    kind: 'adr' as const,
    title,
    snippet,
    score: 1,
  });
  const sources = [
    hit('ADR-003: Autenticação', 'O login é delegado a um provedor OIDC.'),
    hit('Regra', 'Outra coisa.'),
  ];

  assert.equal(
    answer(copilotPrompt('Como é o login?', sources, 'Backlog com 2 histórias.')),
    'O login é delegado a um provedor OIDC. [ADR-003: Autenticação] Veja também: [Regra].',
  );
  assert.equal(
    answer(copilotPrompt('O que está pendente no backlog?', sources, 'Backlog com 2 histórias.')),
    'Backlog com 2 histórias.',
  );
  assert.match(answer(copilotPrompt('Qual a cor do céu?', [], 'Backlog vazio.')), /Não encontrei/);
});
