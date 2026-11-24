import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { Level, UserStory } from '@specpilot/shared-schemas';

const LEVEL: Record<Level, string> = { high: 'alta', medium: 'média', low: 'baixa' };
const IMPACT: Record<Level, string> = { high: 'alto', medium: 'médio', low: 'baixo' };

/**
 * Uma história no board, desenhada como faixa de voo: a borda esquerda leva a cor do status,
 * e as ações ficam sempre à vista, sem depender de passar o mouse.
 */
@Component({
  selector: 'app-story-strip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[attr.data-status]': 'story().status' },
  template: `
    @let item = story();
    <article>
      <p class="epic small muted">{{ epic() }}</p>
      <h4>{{ item.title }}</h4>

      <p class="tags">
        <span class="tag">Prioridade {{ level[item.priority] }}</span>
        <span class="tag" [class.alert]="item.impact === 'high'">Impacto {{ impact[item.impact] }}</span>
        <span class="tag" [class.hold]="item.confidence < 0.7">Confiança {{ percent(item.confidence) }}</span>
      </p>

      @if (item.status === 'pending_approval') {
        <ul class="reasons small">
          @for (reason of item.approvalReasons; track reason) {
            <li>{{ reason }}</li>
          }
        </ul>
        <div class="actions">
          <button class="button small" type="button" (click)="approve.emit()">Aprovar</button>
          <button class="button danger small" type="button" (click)="reject.emit()">Rejeitar</button>
        </div>
      } @else {
        @if (item.approvedBy) {
          <p class="small muted">Aprovada por {{ item.approvedBy }}</p>
        }
        <div class="actions">
          @if (item.status !== 'ready') {
            <button class="button quiet small" type="button" (click)="move.emit(item.status === 'done' ? 'in_progress' : 'ready')">
              Voltar para {{ item.status === 'done' ? 'In Progress' : 'Ready' }}
            </button>
          }
          @if (item.status !== 'done') {
            <button class="button quiet small" type="button" (click)="move.emit(item.status === 'ready' ? 'in_progress' : 'done')">
              Mover para {{ item.status === 'ready' ? 'In Progress' : 'Done' }}
            </button>
          }
        </div>
      }

      <details>
        <summary>História e critérios de aceite</summary>
        <p class="story-text">
          Como <strong>{{ item.asA }}</strong>, quero {{ item.iWant }}, para que {{ item.soThat }}.
        </p>
        @for (criterion of item.acceptanceCriteria; track criterion.scenario) {
          <pre class="code gherkin"><strong>Cenário:</strong> {{ criterion.scenario }}
  <strong>Dado</strong> {{ criterion.given }}
  <strong>Quando</strong> {{ criterion.when }}
  <strong>Então</strong> {{ criterion.then }}</pre>
        }
      </details>
    </article>
  `,
  styles: `
    :host {
      display: block;
      border: 1px solid var(--line);
      border-left: 6px solid var(--landed);
      border-radius: 2px;
      background: var(--panel);
    }
    :host([data-status='pending_approval']) {
      border-left-color: var(--hold);
    }
    :host([data-status='ready']) {
      border-left-color: var(--clear);
    }
    :host([data-status='in_progress']) {
      border-left-color: var(--enroute);
    }
    article {
      padding: 10px 12px;
    }
    h4 {
      font-family: var(--font-display);
      font-size: 1.15rem;
      font-weight: 600;
      line-height: 1.2;
    }
    .tags {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin: 8px 0;
    }
    .reasons {
      margin: 0 0 8px;
      padding-left: 18px;
      color: var(--hold);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    details {
      margin-top: 10px;
      border-top: 1px dashed var(--line);
      padding-top: 8px;
    }
    summary {
      color: var(--route);
      cursor: pointer;
      font-size: 0.9rem;
      font-weight: 500;
    }
    .story-text {
      margin: 8px 0;
    }
    .gherkin {
      margin: 8px 0 0;
      padding: 8px;
      overflow-x: auto;
      background: var(--sky);
      white-space: pre-wrap;
    }
  `,
})
export class StoryStrip {
  readonly story = input.required<UserStory>();
  readonly epic = input('');
  readonly approve = output<void>();
  readonly reject = output<void>();
  readonly move = output<'ready' | 'in_progress' | 'done'>();

  protected readonly level = LEVEL;
  protected readonly impact = IMPACT;
  protected readonly percent = (value: number) => `${Math.round(value * 100)}%`;
}
