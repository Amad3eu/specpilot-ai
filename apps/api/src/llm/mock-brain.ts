import { adrLabel } from '@specpilot/shared-schemas';
import type { AnalystOutput, ReviewerOutput } from '../agents/schemas.js';

// O "cérebro" do provedor mock: heurísticas determinísticas que fazem o papel do modelo
// quando não há chave de API. Lê os mesmos blocos de tags que os prompts montam e devolve
// objetos nos mesmos schemas, para o workflow inteiro rodar igual ao de produção.
//
// Não é um modelo: reconhece verbo de requisito, tema e tecnologia por lista de palavras.
// Serve para avaliar a aplicação de ponta a ponta. Qualidade de extração, só com provedor real.

/** O conteúdo de um bloco `<tag>...</tag>` do prompt. */
export const tagContent = (prompt: string, tag: string) =>
  new RegExp(`<${tag}>\\n?([\\s\\S]*?)\\n?</${tag}>`).exec(prompt)?.[1]?.trim() ?? '';

/** Frases da nota: uma por linha ou por ponto final, sem marcador de lista e sem "Ana (PO):". */
function statements(notes: string): string[] {
  return notes
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-ZÀ-Ú])/))
    .map((line) =>
      line
        .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
        .replace(/^[A-ZÀ-Ú][\wÀ-ú]*(?: [A-ZÀ-Ú][\wÀ-ú]*)?(?: \([^)]*\))?:\s*/, '')
        .trim(),
    )
    .filter((line) => line.length >= 25);
}

const REQUIREMENT =
  /\b(?:precisa|precisam|precisamos|deve|devem|quer|querem|queremos|quero|gostaria|gostaríamos|permitir|possibilitar|necess[aá]rio|pediu|pediram|falta|incluir|adicionar|criar|implementar|enviar|exportar|integrar|notificar)\b/i;

const DECISION =
  /\b(?:vamos usar|vamos adotar|vamos de|adotar|migrar para|trocar .+ por|decidimos|ficou decidido|guardar .+ (?:em|no|na)|salvar .+ (?:em|no|na)|implementar com)\b/i;

interface Theme {
  epic: string;
  summary: string;
  pattern: RegExp;
  impact: 'high' | 'medium' | 'low';
  benefit: string;
  edge: { scenario: string; given: string; when: string; then: string };
}

const THEMES: Theme[] = [
  // A ordem decide o empate: "aviso quando o pagamento falhar" é notificação, não pagamento.
  {
    epic: 'Notificações e comunicação',
    summary: 'Avisos enviados às pessoas sobre o que acontece na plataforma.',
    pattern: /notific|e-?mail|\bsms\b|whatsapp|alerta|aviso|lembrete/i,
    impact: 'medium',
    benefit: 'ninguém perca um evento importante',
    edge: {
      scenario: 'Canal indisponível',
      given: 'que o canal de envio está fora do ar',
      when: 'a notificação é disparada',
      then: 'o envio entra na fila de nova tentativa e a falha fica registrada',
    },
  },
  {
    epic: 'Pagamentos e checkout',
    summary: 'Formas de pagamento, cobrança e conclusão da compra.',
    pattern: /pagament|pix|boleto|cart[aã]o|checkout|cobran|fatura|reembolso/i,
    impact: 'high',
    benefit: 'a compra seja concluída sem sair da plataforma',
    edge: {
      scenario: 'Pagamento não confirmado',
      given: 'que o pagamento foi iniciado',
      when: 'a confirmação não chega dentro do prazo',
      then: 'o pedido fica pendente e a pessoa é avisada do que fazer',
    },
  },
  {
    epic: 'Autenticação e acesso',
    summary: 'Entrada na plataforma, permissões e segurança da conta.',
    pattern: /login|senha|autentic|acesso|permiss|\bsso\b|oauth|2fa|dois fatores/i,
    impact: 'high',
    benefit: 'o acesso seja seguro sem atrapalhar o uso',
    edge: {
      scenario: 'Credencial inválida',
      given: 'que a pessoa informou uma credencial errada',
      when: 'ela tenta entrar',
      then: 'o acesso é negado sem revelar qual dado está errado',
    },
  },
  {
    epic: 'Privacidade e conformidade',
    summary: 'Tratamento de dados pessoais, consentimento e auditoria.',
    pattern: /lgpd|privacidade|consentimento|dados? pessoa|auditoria|anonimiz/i,
    impact: 'high',
    benefit: 'os dados pessoais sejam tratados conforme a LGPD',
    edge: {
      scenario: 'Pedido sem consentimento',
      given: 'que o titular não deu consentimento',
      when: 'o sistema tenta usar o dado',
      then: 'o uso é bloqueado e o evento fica registrado',
    },
  },
  {
    epic: 'Relatórios e indicadores',
    summary: 'Visão dos números do negócio e exportação de dados.',
    pattern: /relat[oó]rio|dashboard|indicador|m[eé]trica|export|\bcsv\b|gr[aá]fico/i,
    impact: 'low',
    benefit: 'as decisões usem dados atualizados',
    edge: {
      scenario: 'Período sem dados',
      given: 'que não há registro no período escolhido',
      when: 'o relatório é gerado',
      then: 'a tela mostra que não há dados, sem erro',
    },
  },
  {
    epic: 'Integrações e API',
    summary: 'Troca de dados com sistemas externos.',
    pattern: /integra|\bapi\b|webhook|\berp\b|sincroniz/i,
    impact: 'medium',
    benefit: 'os sistemas fiquem sincronizados sem trabalho manual',
    edge: {
      scenario: 'Sistema externo fora do ar',
      given: 'que o sistema externo não responde',
      when: 'a integração é chamada',
      then: 'a operação é repetida depois e nenhum dado é perdido',
    },
  },
  {
    epic: 'Catálogo e busca',
    summary: 'Cadastro, organização e descoberta de produtos.',
    pattern: /cat[aá]logo|produto|busca|pesquis|filtro|estoque/i,
    impact: 'medium',
    benefit: 'seja rápido achar o que se procura',
    edge: {
      scenario: 'Busca sem resultado',
      given: 'que nenhum item combina com o termo',
      when: 'a busca é feita',
      then: 'a tela sugere termos parecidos, sem ficar vazia',
    },
  },
];

const GENERAL: Theme = {
  epic: 'Melhorias gerais',
  summary: 'Pedidos da reunião que não se encaixam em um tema maior.',
  pattern: /./,
  impact: 'medium',
  benefit: 'o trabalho do dia a dia fique mais simples',
  edge: {
    scenario: 'Dados inválidos',
    given: 'que os dados enviados estão incompletos',
    when: 'a ação é executada',
    then: 'o sistema explica o erro e não grava nada',
  },
};

const PERSONAS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'gestor', pattern: /gestor|gerente|diretor|lideran/i },
  { name: 'pessoa do financeiro', pattern: /financeiro|contas a|tesouraria/i },
  { name: 'pessoa do suporte', pattern: /suporte|atendente|atendimento/i },
  { name: 'administrador', pattern: /admin/i },
  { name: 'vendedor', pattern: /vendedor|comercial|vendas/i },
  { name: 'cliente', pattern: /cliente|comprador|consumidor/i },
];

/** Tira o sujeito e o verbo de pedido do começo: sobra o que a pessoa quer. */
function wantOf(line: string): string {
  const want = line
    .replace(/^como (?:um |uma )?[^,]+,\s*/i, '')
    .replace(/^(?:talvez|quem sabe|seria bom|se der tempo,?)\s+/i, '')
    .replace(
      /^(?:(?:o|a|os|as|nosso|nossa)\s+)?(?:(?:cliente|clientes|usu[aá]rio|usu[aá]rios|time|equipe|gente|pessoal|financeiro|suporte|vendedor(?:es)?|gestor(?:es)?|admin\w*)\s+)?(?:(?:tamb[eé]m|ainda)\s+)?(?:eu\s+)?(?:precisa(?:m|mos)?(?: poder)?(?: de)?|quer(?:o|em|emos)?|deve(?:m|mos)?|gostar(?:ia|iam|íamos) de|pedi(?:u|ram)(?: para)?|tem(?:os)? que|falta)\s+/i,
      '',
    )
    // Comentário de reunião no fim da frase não faz parte do pedido.
    .replace(/[,;]?\s*(?:isso [eé] urgente|[eé] urgente|urgente|ver depois|se der tempo|para ontem)\s*[.!?]*$/i, '')
    .replace(/[.!?]+$/, '')
    .trim();
  return want.charAt(0).toLowerCase() + want.slice(1);
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** O papel do ProductAnalystAgent: épicos e histórias a partir das frases de requisito. */
export function analyze(prompt: string): AnalystOutput {
  const epics = new Map<Theme, AnalystOutput['epics'][number]>();

  for (const line of statements(tagContent(prompt, 'notas'))) {
    // Frase de decisão técnica é assunto do revisor de arquitetura, não uma história.
    if (!REQUIREMENT.test(line) || DECISION.test(line)) continue;

    const theme = THEMES.find(({ pattern }) => pattern.test(line)) ?? GENERAL;
    const persona = PERSONAS.find(({ pattern }) => pattern.test(line))?.name ?? 'pessoa usuária';
    const want = wantOf(line);
    const title = capitalize(want.split(/,| para que | porque /)[0] ?? want).slice(0, 90);
    const benefit = /\bpara que (.+)$/i.exec(want)?.[1] ?? theme.benefit;

    const vague = /talvez|n[aã]o sei|a definir|ver depois|quem sabe|\?/i.test(line);
    const urgent = /urgente|cr[ií]tico|bloque|prazo|esta sprint|imediat|antes do lan[cç]amento/i.test(line);
    const later = /depois|futuro|seria bom|se der tempo|n[aã]o [eé] prioridade/i.test(line);

    const epic = epics.get(theme) ?? { title: theme.epic, summary: theme.summary, stories: [] };
    epics.set(theme, epic);
    epic.stories.push({
      title,
      asA: persona,
      iWant: want.replace(/ para que .+$/i, ''),
      soThat: benefit,
      acceptanceCriteria: [
        {
          scenario: `${title} com sucesso`,
          given: `que sou ${persona} com acesso à plataforma`,
          when: `a ação "${title}" é executada com dados válidos`,
          then: 'o sistema conclui a operação e mostra a confirmação',
        },
        theme.edge,
      ],
      priority: urgent ? 'high' : later ? 'low' : 'medium',
      impact: /migra|exclu|apagar|produ[cç][aã]o/i.test(line) ? 'high' : theme.impact,
      confidence: Math.max(0.3, 0.88 - (vague ? 0.3 : 0) - (line.length < 45 ? 0.1 : 0)),
    });
  }
  return { epics: [...epics.values()] };
}

/** Tecnologias que competem entre si, por categoria. A primeira coluna é o nome que aparece no ADR. */
const TECH_CATEGORIES: Array<{ label: string; techs: Array<[string, RegExp]> }> = [
  {
    label: 'banco de dados',
    techs: [
      ['PostgreSQL', /postgres(?:ql)?/i],
      ['MySQL', /mysql/i],
      ['MongoDB', /mongo(?:db)?/i],
      ['DynamoDB', /dynamo(?:db)?/i],
      ['Firebase', /firebase|firestore/i],
    ],
  },
  {
    label: 'estilo de API',
    techs: [
      ['REST', /\brest\b|openapi/i],
      ['GraphQL', /graphql/i],
      ['gRPC', /grpc/i],
    ],
  },
  {
    label: 'autenticação',
    techs: [
      ['OAuth 2.0 / OIDC', /oauth|oidc|\bsso\b/i],
      ['login próprio com senha', /login pr[oó]prio|senha pr[oó]pria|usu[aá]rio e senha/i],
    ],
  },
  {
    label: 'mensageria',
    techs: [
      ['Kafka', /kafka/i],
      ['RabbitMQ', /rabbit(?:mq)?/i],
      ['SQS', /\bsqs\b/i],
    ],
  },
];

/** O papel do ArchitectReviewerAgent: conflitos com ADRs aceitos e ADRs novos a propor. */
export function review(prompt: string): ReviewerOutput {
  // Cada linha do bloco: "ADR-001 | título | decisão". O padrão do ADR é o que o TÍTULO afirma.
  const adrs = tagContent(prompt, 'adrs')
    .split('\n')
    .flatMap((line) => {
      const match = /^ADR-(\d+) \| ([^|]+) \|/.exec(line);
      return match ? [{ number: Number(match[1]), title: (match[2] ?? '').trim() }] : [];
    });
  const stories = tagContent(prompt, 'historias')
    .split('\n')
    .map((line) => line.replace(/^- /, '').trim())
    .filter(Boolean);

  const output: ReviewerOutput = { conflicts: [], proposedAdrs: [] };
  const proposed = new Set<string>();

  for (const line of statements(tagContent(prompt, 'notas')).filter((statement) => DECISION.test(statement))) {
    for (const { label, techs } of TECH_CATEGORIES) {
      for (const [tech, pattern] of techs) {
        if (!pattern.test(line)) continue;
        // Já é o padrão de algum ADR aceito: a nota só repete a decisão.
        if (adrs.some((adr) => pattern.test(adr.title))) continue;

        const rival = adrs.flatMap((adr) => {
          const standard = techs.find(([, other]) => other.test(adr.title));
          return standard ? [{ adr, standard: standard[0] }] : [];
        })[0];

        if (rival) {
          output.conflicts.push({
            adrNumber: rival.adr.number,
            description: `A reunião propõe ${tech} para ${label}, e o ${adrLabel(rival.adr.number)} define ${rival.standard}.`,
            severity: 'high',
            affectedStories: stories.filter((title) => pattern.test(title)),
          });
        }

        const title = rival ? `Trocar ${rival.standard} por ${tech} em ${label}` : `Adotar ${tech} para ${label}`;
        if (proposed.has(title)) continue;
        proposed.add(title);
        output.proposedAdrs.push({
          title,
          context: `Na reunião: "${line}"${rival ? ` O ${adrLabel(rival.adr.number)} hoje define ${rival.standard}.` : ''}`,
          decision: rival
            ? `Em avaliação: usar ${tech} para ${label}, no lugar de ${rival.standard}.`
            : `Usar ${tech} para ${label}.`,
          consequences: rival
            ? `Exige rever o ${adrLabel(rival.adr.number)} e planejar a migração do que já usa ${rival.standard}.`
            : `Mais uma tecnologia para o time operar, monitorar e documentar.`,
        });
      }
    }
  }
  return output;
}

/** O papel do copiloto: responde com o trecho da melhor fonte, ou com o resumo do backlog. */
export function answer(prompt: string): string {
  const question = tagContent(prompt, 'pergunta');
  if (/backlog|hist[oó]ria|pendente|aprova|board|[eé]pico/i.test(question)) return tagContent(prompt, 'backlog');

  const sources = tagContent(prompt, 'fontes')
    .split('\n')
    .flatMap((line) => {
      const match = /^\[([^\]]+)\] (.+)$/.exec(line);
      return match ? [{ title: match[1] ?? '', snippet: match[2] ?? '' }] : [];
    });
  const [best, ...others] = sources;
  if (!best) return 'Não encontrei nada sobre isso na base de conhecimento do projeto.';

  const also = others.length > 0 ? ` Veja também: ${others.map((source) => `[${source.title}]`).join(', ')}.` : '';
  // Em um ADR, a resposta é a decisão, não o contexto que veio antes dela.
  const decision = /Decisão: (.+?)(?: Consequências:|$)/.exec(best.snippet)?.[1];
  return `${decision ?? best.snippet} [${best.title}]${also}`;
}
