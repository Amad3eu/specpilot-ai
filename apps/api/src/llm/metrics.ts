// Métricas da sessão: o que a barra do front-end mostra. Vivem no processo e zeram a cada subida.

export interface LlmUsage {
  llmCalls: number;
  cacheHits: number;
  tokensIn: number;
  tokensOut: number;
  avgLatencyMs: number;
  estimatedCostUsd: number;
}

export type Metrics = ReturnType<typeof createMetrics>;

export function createMetrics() {
  const totals = { llmCalls: 0, cacheHits: 0, tokensIn: 0, tokensOut: 0, latencyMs: 0, estimatedCostUsd: 0 };

  return {
    /** Uma chamada que foi de fato ao provedor. */
    recordCall(call: { latencyMs: number; tokensIn: number; tokensOut: number; costUsd: number }): void {
      totals.llmCalls++;
      totals.tokensIn += call.tokensIn;
      totals.tokensOut += call.tokensOut;
      totals.latencyMs += call.latencyMs;
      totals.estimatedCostUsd += call.costUsd;
    },
    /** Uma resposta que saiu do cache: não gastou token nem tempo de modelo. */
    recordCacheHit(): void {
      totals.cacheHits++;
    },
    snapshot(): LlmUsage {
      const { latencyMs, ...usage } = totals;
      return { ...usage, avgLatencyMs: totals.llmCalls > 0 ? latencyMs / totals.llmCalls : 0 };
    },
  };
}
