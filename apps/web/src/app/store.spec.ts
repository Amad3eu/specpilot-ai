import { TestBed } from '@angular/core/testing';
import type { IngestResult, StreamEvent, UserStory } from '@specpilot/shared-schemas';
import { ApiError, SpecPilotApi } from './api';
import { SpecPilotStore } from './store';

const story = (id: string, status: UserStory['status']): UserStory => ({
  id,
  epicId: 'e1',
  title: `História ${id}`,
  asA: 'cliente',
  iWant: 'pagar',
  soThat: 'eu compre',
  acceptanceCriteria: [{ scenario: 's', given: 'g', when: 'w', then: 't' }],
  priority: 'medium',
  impact: 'medium',
  confidence: 0.9,
  status,
  approvalReasons: [],
  approvedBy: null,
  createdAt: '2026-11-24T12:00:00.000Z',
});

const RESULT = {
  runId: 'r1',
  stories: [],
  epics: [],
  proposedAdrs: [],
  conflicts: [],
  context: [],
} as unknown as IngestResult;

/** Uma API falsa: devolve o backlog que o teste montar e guarda as chamadas. */
function setup(stories: UserStory[], events: StreamEvent[] = []) {
  const api = {
    health: async () => ({ status: 'ok', mode: { provider: 'mock', store: 'memory', cache: 'memory' } }),
    backlog: vi.fn(async () => ({ epics: [{ id: 'e1', title: 'Pagamentos', summary: '', createdAt: '' }], stories })),
    adrs: async () => [],
    documents: async () => [],
    metrics: async () => null,
    approveStory: vi.fn(async () => stories[0]),
    moveStory: vi.fn(async (): Promise<UserStory> => {
      throw new ApiError('Esta história ainda espera aprovação humana: aprove antes de mover.');
    }),
    ingest: vi.fn(async (_notes: string, onEvent: (event: StreamEvent) => void) => {
      for (const event of events) onEvent(event);
    }),
  };
  TestBed.configureTestingModule({ providers: [{ provide: SpecPilotApi, useValue: api }] });
  return { store: TestBed.inject(SpecPilotStore), api };
}

describe('SpecPilotStore', () => {
  it('distribui as histórias nas quatro colunas e deixa a rejeitada fora do board', async () => {
    const { store } = setup([
      story('a', 'pending_approval'),
      story('b', 'ready'),
      story('c', 'ready'),
      story('d', 'rejected'),
    ]);
    await store.refresh();

    const columns = store.columns();
    expect(Object.keys(columns)).toEqual(['pending_approval', 'ready', 'in_progress', 'done']);
    expect(columns.pending_approval.map((item) => item.id)).toEqual(['a']);
    expect(columns.ready.map((item) => item.id)).toEqual(['b', 'c']);
    expect(columns.done).toEqual([]);
    expect(store.pendingCount()).toBe(1);
    expect(store.epicTitles()).toEqual({ e1: 'Pagamentos' });
    expect(store.mode()?.provider).toBe('mock');
  });

  it('acompanha cada agente pelos eventos do stream e guarda o resultado', async () => {
    const { store, api } = setup(
      [],
      [
        { type: 'run_started', runId: 'r1' },
        { type: 'agent_started', agent: 'context_retriever' },
        { type: 'agent_finished', agent: 'context_retriever', summary: '3 trechos', durationMs: 8 },
        { type: 'agent_started', agent: 'product_analyst' },
        { type: 'result', result: RESULT },
      ],
    );
    await store.ingest('O cliente precisa pagar com PIX no checkout.');

    expect(store.steps().context_retriever).toEqual({ state: 'done', summary: '3 trechos', durationMs: 8 });
    expect(store.steps().product_analyst.state).toBe('running');
    expect(store.steps().human_approval_gate.state).toBe('waiting');
    expect(store.lastRun()?.runId).toBe('r1');
    expect(store.running()).toBe(false);
    // Depois da ingestão o board é relido do servidor.
    expect(api.backlog).toHaveBeenCalled();
  });

  it('evento de erro do workflow vira mensagem na tela', async () => {
    const { store } = setup([], [{ type: 'error', message: 'O workflow falhou. Veja o log da API.' }]);
    await store.ingest('O cliente precisa pagar com PIX no checkout.');

    expect(store.error()).toBe('O workflow falhou. Veja o log da API.');
    expect(store.running()).toBe(false);
  });

  it('aprovar chama a API com o nome de quem aprovou e relê o board', async () => {
    const pending = story('a', 'pending_approval');
    const { store, api } = setup([pending]);

    expect(await store.approve(pending, 'Ana')).toBe(true);
    expect(api.approveStory).toHaveBeenCalledWith('a', 'Ana');
    expect(api.backlog).toHaveBeenCalledTimes(1);
    expect(store.error()).toBeNull();
  });

  it('ação recusada pela API mostra o motivo, e o board é relido mesmo assim', async () => {
    const pending = story('a', 'pending_approval');
    const { store, api } = setup([pending]);

    expect(await store.move(pending, 'done')).toBe(false);
    expect(store.error()).toBe('Esta história ainda espera aprovação humana: aprove antes de mover.');
    expect(api.backlog).toHaveBeenCalledTimes(1);
  });
});
