import { TestBed } from '@angular/core/testing';
import { ApiError, SpecPilotApi } from './api';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('SpecPilotApi', () => {
  const fetchMock = vi.fn<typeof fetch>();
  let api: SpecPilotApi;

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    api = TestBed.inject(SpecPilotApi);
  });
  afterEach(() => vi.unstubAllGlobals());

  const lastCall = () => {
    const [url, init] = fetchMock.mock.calls.at(-1) ?? [];
    return { url, method: init?.method, headers: init?.headers as Record<string, string>, body: init?.body };
  };

  it('pedido com corpo vai como JSON e identificado como board', async () => {
    fetchMock.mockResolvedValue(json({ id: 's1' }));
    await api.approveStory('s1', 'Ana');

    expect(lastCall()).toEqual({
      url: '/api/stories/s1/approve',
      method: 'POST',
      headers: { 'x-specpilot-actor': 'board', 'content-type': 'application/json' },
      body: '{"approvedBy":"Ana"}',
    });
  });

  it('pedido sem corpo não se declara JSON: a API recusa JSON vazio', async () => {
    fetchMock.mockResolvedValue(json({ id: 'a1' }));
    await api.approveAdr('a1');
    expect(lastCall().headers).toEqual({ 'x-specpilot-actor': 'board' });
    expect(lastCall().body).toBeUndefined();

    await api.rejectStory('s1');
    expect(lastCall().headers).toEqual({ 'x-specpilot-actor': 'board' });
  });

  it('erro explicado pela API vira ApiError com a mensagem dela', async () => {
    fetchMock.mockResolvedValue(json({ error: 'Só um ADR proposto pode ser aceito.' }, 409));
    await expect(api.approveAdr('a1')).rejects.toThrow(new ApiError('Só um ADR proposto pode ser aceito.'));
  });

  it('API fora do ar vira uma mensagem que diz o que fazer', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(api.backlog()).rejects.toThrow(/Rode "pnpm dev"/);
  });

  it('a busca codifica a pergunta na URL', async () => {
    fetchMock.mockResolvedValue(json([]));
    await api.search('qual banco & por quê?');
    expect(lastCall().url).toBe('/api/knowledge/search?q=qual%20banco%20%26%20por%20qu%C3%AA%3F');
  });
});
