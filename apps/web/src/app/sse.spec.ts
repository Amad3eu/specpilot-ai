import type { StreamEvent } from '@specpilot/shared-schemas';
import { parseSseChunk, readEventStream } from './sse';

const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
const started: StreamEvent = { type: 'agent_started', agent: 'product_analyst' };
const finished: StreamEvent = {
  type: 'agent_finished',
  agent: 'product_analyst',
  summary: '2 histórias',
  durationMs: 12,
};

describe('parseSseChunk', () => {
  it('separa os eventos completos e devolve o resto para o próximo pedaço', () => {
    const half = frame(finished).slice(0, 20);
    const { events, rest } = parseSseChunk(frame(started) + half);

    expect(events).toEqual([started]);
    expect(rest).toBe(half);
    expect(parseSseChunk(rest + frame(finished).slice(20)).events).toEqual([finished]);
  });

  it('ignora o que não é JSON e o evento fora do contrato', () => {
    const { events } = parseSseChunk(`data: isto não é json\n\n${frame({ type: 'desconhecido' })}${frame(started)}`);
    expect(events).toEqual([started]);
  });
});

describe('readEventStream', () => {
  it('entrega cada evento, mesmo quando a rede corta no meio de um', async () => {
    const text = frame(started) + frame(finished);
    const bytes = new TextEncoder().encode(text);
    // Três pedaços, com os cortes caindo dentro dos eventos.
    const cuts = [bytes.slice(0, 15), bytes.slice(15, 70), bytes.slice(70)];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const cut of cuts) controller.enqueue(cut);
        controller.close();
      },
    });

    const received: StreamEvent[] = [];
    await readEventStream(new Response(body), (event) => received.push(event));
    expect(received).toEqual([started, finished]);
  });
});
