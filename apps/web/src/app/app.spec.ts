import { TestBed } from '@angular/core/testing';
import { SpecPilotApi } from './api';
import { App } from './app';
import { SpecPilotStore } from './store';

/** A API falsa de uma sessão recém-aberta: uma história esperando aprovação e nada mais. */
const api = {
  health: async () => ({ status: 'ok', mode: { provider: 'mock', store: 'memory', cache: 'memory' } }),
  backlog: async () => ({
    epics: [{ id: 'e1', title: 'Pagamentos e checkout', summary: '', createdAt: '' }],
    stories: [
      {
        id: 's1',
        epicId: 'e1',
        title: 'Pagar com PIX no checkout',
        asA: 'cliente',
        iWant: 'pagar com PIX',
        soThat: 'a compra seja concluída',
        acceptanceCriteria: [{ scenario: 'Pagamento aprovado', given: 'g', when: 'w', then: 't' }],
        priority: 'medium',
        impact: 'high',
        confidence: 0.88,
        status: 'pending_approval',
        approvalReasons: ['Impacto alto: errar aqui custa caro.'],
        approvedBy: null,
        createdAt: '2026-11-24T12:00:00.000Z',
      },
    ],
  }),
  adrs: async () => [],
  documents: async () => [],
  metrics: async () => ({
    llmCalls: 3,
    cacheHits: 1,
    tokensIn: 900,
    tokensOut: 400,
    avgLatencyMs: 2,
    estimatedCostUsd: 0.0031,
    costIsReference: true,
    provider: 'mock',
    store: 'memory',
    cache: 'memory',
  }),
};

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: SpecPilotApi, useValue: api }],
    }).compileComponents();
  });

  const render = async () => {
    const fixture = TestBed.createComponent(App);
    // A carga inicial é um fetch: o teste espera por ela antes de olhar a tela.
    await TestBed.inject(SpecPilotStore).refresh();
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  };

  it('mostra a marca, as três áreas e o modo em que a API está rodando', async () => {
    const page = await render();

    expect(page.querySelector('h1')?.textContent).toBe('SpecPilot');
    const tabs = [...page.querySelectorAll('nav button')].map((button) => button.textContent?.trim().split(/\s+/)[0]);
    expect(tabs).toEqual(['Board', 'ADRs', 'Copiloto']);
    expect(page.querySelector('.mode')?.textContent).toContain('Postgres embutido');
    expect(page.textContent).toContain('Modo de avaliação');
  });

  it('o board tem as quatro colunas, e a história pendente aparece com os botões do gate', async () => {
    const page = await render();

    const columns = [...page.querySelectorAll('.bay h3')].map((title) => title.textContent?.replace(/\d+/, '').trim());
    expect(columns).toEqual(['Pending Approval', 'Ready', 'In Progress', 'Done']);

    const strip = page.querySelector('.bay[data-status="pending_approval"] app-story-strip');
    expect(strip?.querySelector('h4')?.textContent).toBe('Pagar com PIX no checkout');
    expect(strip?.textContent).toContain('Impacto alto: errar aqui custa caro.');
    expect([...(strip?.querySelectorAll('button') ?? [])].map((button) => button.textContent?.trim())).toEqual([
      'Aprovar',
      'Rejeitar',
    ]);
    // O contador de pendentes aparece na aba do board.
    expect(page.querySelector('nav .badge')?.textContent).toContain('1');
  });

  it('a barra de métricas mostra cache hits e o custo, marcado como de referência no mock', async () => {
    const page = await render();
    const metrics = page.querySelector('app-metrics-bar')?.textContent ?? '';

    expect(metrics).toContain('Respostas do cache');
    expect(metrics).toContain('US$ 0.0031');
    expect(metrics).toContain('preço de referência');
  });
});
