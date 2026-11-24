import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { SpecPilotStore } from './store';

/** A barra de métricas da sessão: latência, chamadas ao modelo, cache hits e custo estimado. */
@Component({
  selector: 'app-metrics-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.metrics(); as metrics) {
      <dl class="metrics" aria-label="Métricas da sessão">
        <div>
          <dt>Latência média do modelo</dt>
          <dd>{{ metrics.avgLatencyMs }} ms</dd>
        </div>
        <div>
          <dt>Chamadas ao modelo</dt>
          <dd>{{ metrics.llmCalls }}</dd>
        </div>
        <div>
          <dt>Respostas do cache</dt>
          <dd>{{ metrics.cacheHits }}</dd>
        </div>
        <div>
          <dt>Tokens de entrada e saída</dt>
          <dd>{{ metrics.tokensIn }} / {{ metrics.tokensOut }}</dd>
        </div>
        <div>
          <dt>Custo estimado da sessão</dt>
          <dd>
            US$ {{ metrics.estimatedCostUsd.toFixed(4) }}
            @if (metrics.costIsReference) {
              <span class="note">preço de referência: o mock não cobra</span>
            }
          </dd>
        </div>
      </dl>
    }
  `,
  styles: `
    .metrics {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 28px;
      margin: 0;
      padding: 10px 20px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    dt {
      color: var(--ink-soft);
      font-size: 0.85rem;
    }
    dd {
      margin: 0;
      font-family: var(--font-display);
      font-size: 1.35rem;
      font-weight: 600;
      line-height: 1.1;
    }
    .note {
      margin-left: 6px;
      color: var(--ink-soft);
      font-family: var(--font);
      font-size: 0.8rem;
      font-weight: 400;
    }
  `,
})
export class MetricsBar {
  protected readonly store = inject(SpecPilotStore);
}
