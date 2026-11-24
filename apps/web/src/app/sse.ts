import type { StreamEvent } from '@specpilot/shared-schemas';
import { STREAM_EVENT_TYPES } from '@specpilot/shared-schemas/constants';

// Leitor de Server-Sent Events para um POST. O EventSource do navegador só faz GET, e a
// ingestão manda a nota no corpo: por isso a leitura é feita à mão, sobre o stream do fetch.

/**
 * O evento veio da nossa própria API, que já o validou com o schema Zod antes de enviar.
 * Aqui basta conferir que é um evento conhecido: tipo novo, de uma API mais nova que a
 * tela, é ignorado em vez de quebrar o board.
 */
function isStreamEvent(value: unknown): value is StreamEvent {
  const type = (value as { type?: unknown } | null)?.type;
  return typeof type === 'string' && (STREAM_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * Separa os eventos completos de um pedaço de stream. Um evento termina em linha em branco;
 * o que sobrar depois da última é devolvido em `rest`, para juntar com o próximo pedaço.
 */
export function parseSseChunk(buffer: string): { events: StreamEvent[]; rest: string } {
  const frames = buffer.split('\n\n');
  const rest = frames.pop() ?? '';
  const events: StreamEvent[] = [];
  for (const frame of frames) {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .join('');
    if (!data) continue;
    try {
      const event: unknown = JSON.parse(data);
      if (isStreamEvent(event)) events.push(event);
    } catch {
      // Pedaço que não é JSON: ignora.
    }
  }
  return { events, rest };
}

/** Lê o corpo de uma resposta SSE e entrega cada evento assim que ele chega. */
export async function readEventStream(response: Response, onEvent: (event: StreamEvent) => void): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const { events, rest } = parseSseChunk(done ? `${buffer}\n\n` : buffer);
    buffer = rest;
    for (const event of events) onEvent(event);
    if (done) return;
  }
}
