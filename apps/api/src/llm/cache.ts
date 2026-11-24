import { createClient } from 'redis';

// Cache de respostas do modelo. A mesma pergunta, com o mesmo contexto e o mesmo modelo,
// não é paga duas vezes. Redis quando há REDIS_URL; um Map no processo quando não há.

export interface CacheStore {
  readonly kind: 'redis' | 'memory';
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  close(): Promise<void>;
}

export function memoryCache(now: () => number = Date.now): CacheStore {
  const entries = new Map<string, { value: string; expiresAt: number }>();
  return {
    kind: 'memory',
    async get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, ttlSeconds) {
      entries.set(key, { value, expiresAt: now() + ttlSeconds * 1000 });
    },
    async close() {
      entries.clear();
    },
  };
}

/**
 * Abre o cache. Redis fora do ar não derruba a API: o cache é otimização, então a subida
 * segue com o cache em memória e avisa.
 */
export async function openCache(redisUrl: string | undefined, warn: (message: string) => void): Promise<CacheStore> {
  if (!redisUrl) return memoryCache();

  const client = createClient({ url: redisUrl, socket: { connectTimeout: 2_000, reconnectStrategy: false } });
  // Sem um listener, um erro de conexão derruba o processo.
  client.on('error', () => undefined);
  try {
    await client.connect();
  } catch (error) {
    warn(`Redis indisponível em REDIS_URL (${error instanceof Error ? error.message : error}): cache em memória.`);
    return memoryCache();
  }
  return {
    kind: 'redis',
    get: (key) => client.get(key),
    set: async (key, value, ttlSeconds) => {
      await client.setEx(key, ttlSeconds, value);
    },
    close: async () => {
      await client.quit();
    },
  };
}
