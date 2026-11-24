// O que do contrato é valor puro, sem Zod. O front importa daqui: os schemas ficam fora do
// pacote do navegador (o Zod pesava mais do que o resto da aplicação inteira), e a tela usa
// só os TIPOS de index.ts, que somem na compilação.

/** As colunas do board, na ordem em que aparecem. `rejected` é status, mas não é coluna. */
export const BOARD_COLUMNS = ['pending_approval', 'ready', 'in_progress', 'done'] as const;

/** Os tipos de evento do stream de ingestão. */
export const STREAM_EVENT_TYPES = ['run_started', 'agent_started', 'agent_finished', 'result', 'error'] as const;

/** Como um ADR é citado em toda a aplicação: ADR-001, ADR-012. */
export const adrLabel = (number: number) => `ADR-${String(number).padStart(3, '0')}`;
