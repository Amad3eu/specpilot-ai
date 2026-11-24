import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { adrLabel, StoryStatus, type UserStory } from '@specpilot/shared-schemas';
import { z } from 'zod';
import { ApiError, type SpecPilotClient } from './client.js';

// As tools e os resources do SpecPilot para IDEs e agentes.
//
//   tools       ações: ingerir uma nota de reunião, listar histórias, aprovar, buscar na arquitetura
//   resources   leitura: o resumo do backlog e o índice de ADRs, para entrar no contexto do agente
//
// O servidor não decide nada: cada tool chama a API, e as regras (o gate de aprovação
// humana, a validação de entrada) são as mesmas que valem para o board.

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
const failure = (value: string) => ({ ...text(value), isError: true });

/** Erro explicado pela API volta para o agente como resultado de tool, para ele poder corrigir. */
const guarded = async (run: () => Promise<string>) => {
  try {
    return text(await run());
  } catch (error) {
    if (error instanceof ApiError) return failure(error.message);
    throw error;
  }
};

const STATUS_LABEL: Record<StoryStatus, string> = {
  pending_approval: 'aguardando aprovação',
  ready: 'pronta',
  in_progress: 'em andamento',
  done: 'concluída',
  rejected: 'rejeitada',
};

const storyLine = (story: UserStory) =>
  `- [${STATUS_LABEL[story.status]}] ${story.title} (id: ${story.id}; prioridade ${story.priority}, impacto ${story.impact})`;

export function createSpecPilotServer(client: SpecPilotClient): McpServer {
  const server = new McpServer({ name: 'specpilot', version: '0.1.0' });

  // --- Tools ------------------------------------------------------------------------------------

  server.registerTool(
    'ingest_meeting_notes',
    {
      title: 'Ingerir nota de reunião',
      description:
        'Transforma uma nota ou transcrição de reunião em épicos, histórias de usuário com critérios Gherkin e ADRs propostos. ' +
        'Histórias de alto impacto ou baixa confiança ficam aguardando aprovação humana.',
      inputSchema: { notes: z.string().min(20).describe('O texto da nota ou da transcrição da reunião.') },
    },
    ({ notes }) =>
      guarded(async () => {
        const result = await client.ingest(notes);
        const lines = [
          `${result.stories.length} histórias criadas em ${result.epics.length} épicos.`,
          ...result.stories.map(storyLine),
        ];
        if (result.skippedDuplicates > 0)
          lines.push(`${result.skippedDuplicates} histórias já existiam e não foram duplicadas.`);
        for (const conflict of result.conflicts) {
          lines.push(`Conflito com ${adrLabel(conflict.adrNumber)} (${conflict.adrTitle}): ${conflict.description}`);
        }
        for (const adr of result.proposedAdrs)
          lines.push(`ADR proposto, aguardando decisão: ${adrLabel(adr.number)} ${adr.title}`);
        if (result.guardrail.flagged)
          lines.push(`Atenção: a nota ${result.guardrail.reasons.join(' e ')}. Tudo foi para aprovação humana.`);
        return lines.join('\n');
      }),
  );

  server.registerTool(
    'list_backlog_stories',
    {
      title: 'Listar histórias do backlog',
      description: 'Lista as histórias do backlog com id, status, prioridade e impacto. Filtre por status se quiser.',
      inputSchema: {
        status: StoryStatus.optional().describe('Só as histórias neste status. Sem filtro, todas as do board.'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ status }) =>
      guarded(async () => {
        const stories = await client.listStories(status);
        return stories.length > 0 ? stories.map(storyLine).join('\n') : 'Nenhuma história com esse filtro.';
      }),
  );

  server.registerTool(
    'approve_story',
    {
      title: 'Aprovar história',
      description:
        'Aprova uma história que está aguardando aprovação humana e a move para pronta. ' +
        'Use só depois de uma pessoa confirmar a aprovação, e informe o nome dela: a aprovação fica na trilha de auditoria.',
      inputSchema: {
        storyId: z.string().min(1).describe('O id da história, como aparece em list_backlog_stories.'),
        approvedBy: z.string().min(1).describe('Nome da pessoa que aprovou.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    ({ storyId, approvedBy }) =>
      guarded(async () => {
        const story = await client.approveStory(storyId, approvedBy);
        return `Aprovada por ${story.approvedBy}: "${story.title}" agora está ${STATUS_LABEL[story.status]}.`;
      }),
  );

  server.registerTool(
    'search_architecture_docs',
    {
      title: 'Buscar na arquitetura',
      description:
        'Busca híbrida (vetorial e lexical) nos ADRs, regras e documentos do projeto. Devolve os trechos mais relevantes.',
      inputSchema: {
        query: z.string().min(2).describe('Pergunta ou termo. Ex.: "qual banco de dados usamos?" ou "ADR-002".'),
        limit: z.number().int().min(1).max(10).default(5).describe('Quantos trechos devolver.'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ query, limit }) =>
      guarded(async () => {
        const hits = await client.search(query, limit);
        return hits.length > 0
          ? hits.map((hit) => `## ${hit.title} (${hit.kind})\n${hit.snippet}`).join('\n\n')
          : `Nada na base de conhecimento sobre "${query}".`;
      }),
  );

  // --- Resources --------------------------------------------------------------------------------

  server.registerResource(
    'backlog-summary',
    'specpilot://backlog/summary',
    {
      title: 'Resumo do backlog',
      description: 'Quantas histórias há em cada coluna do board e quais esperam aprovação humana.',
      mimeType: 'text/plain',
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: await client.backlogSummary() }] }),
  );

  server.registerResource(
    'adrs-index',
    'specpilot://adrs/index',
    {
      title: 'Índice de ADRs',
      description: 'Os Architecture Decision Records do projeto, com status e decisão.',
      mimeType: 'text/markdown',
    },
    async (uri) => {
      const adrs = await client.listAdrs();
      const index = adrs.map((adr) => `- **${adrLabel(adr.number)}: ${adr.title}** (${adr.status})\n  ${adr.decision}`);
      return {
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text: `# ADRs do projeto\n\n${index.join('\n')}` }],
      };
    },
  );

  return server;
}
