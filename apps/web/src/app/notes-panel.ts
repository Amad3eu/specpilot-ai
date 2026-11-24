import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { adrLabel } from '@specpilot/shared-schemas/constants';
import { EXAMPLES, type ExampleNote } from './examples';
import { AGENTS, SpecPilotStore } from './store';

/**
 * Entrada da nota de reunião, o checklist dos quatro agentes enquanto o workflow roda, e o
 * resumo do que saiu: conflitos, ADRs propostos e o contexto que os agentes usaram.
 */
@Component({
  selector: 'app-notes-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel stack" aria-labelledby="notes-title">
      <h2 id="notes-title">Nota de reunião</h2>

      <div>
        <label for="notes">Cole a nota ou a transcrição</label>
        <textarea
          id="notes"
          rows="8"
          [value]="notes()"
          (input)="notes.set($any($event.target).value)"
          placeholder="Ana (PO): O cliente precisa pagar com PIX no checkout..."
        ></textarea>
      </div>

      <button class="button" type="button" [disabled]="store.running() || notes().trim().length < 20" (click)="run()">
        {{ store.running() ? 'Gerando backlog…' : 'Gerar backlog' }}
      </button>

      <div>
        <p class="small muted">Ou rode um exemplo pronto:</p>
        <ul class="examples">
          @for (example of examples; track example.label) {
            <li>
              <button class="button quiet small" type="button" [disabled]="store.running()" (click)="runExample(example)">
                {{ example.label }}
              </button>
              <span class="small muted">{{ example.shows }}</span>
            </li>
          }
        </ul>
      </div>
    </section>

    <section class="panel stack" aria-labelledby="flight-title">
      <h2 id="flight-title">Workflow dos agentes</h2>
      <ol class="checklist">
        @for (agent of agents; track agent.name) {
          @let step = store.steps()[agent.name];
          <li [attr.data-state]="step.state">
            <span class="mark" aria-hidden="true">{{ step.state === 'done' ? '✓' : $index + 1 }}</span>
            <div>
              <strong>{{ agent.label }}</strong>
              <span class="sr-only">{{ stateLabel[step.state] }}</span>
              @if (step.durationMs !== null) {
                <span class="duration small muted">{{ step.durationMs }} ms</span>
              }
              <p class="small muted">{{ step.summary || agent.does }}</p>
            </div>
          </li>
        }
      </ol>

      @if (store.lastRun(); as run) {
        <div class="stack" aria-live="polite">
          <p>
            <strong>{{ run.stories.length === 1 ? '1 história criada' : run.stories.length + ' histórias criadas' }}</strong>
            @if (run.skippedDuplicates > 0) {
              , {{ run.skippedDuplicates }} já existiam
            }
            em {{ run.metrics.durationMs }} ms, com {{ run.metrics.llmCalls }} chamadas ao modelo e
            {{ run.metrics.cacheHits }} respostas do cache.
          </p>

          @if (run.guardrail.flagged) {
            <p class="notice hold">
              A nota {{ run.guardrail.reasons.join(' e ') }}. Nada do que saiu dela foi para o board sem passar por
              aprovação humana.
            </p>
          }

          @for (conflict of run.conflicts; track conflict.description) {
            <p class="notice alert">
              <strong>Conflito com {{ label(conflict.adrNumber) }}.</strong> {{ conflict.description }}
            </p>
          }

          @if (run.proposedAdrs.length > 0) {
            <p class="notice">
              {{ run.proposedAdrs.length }} ADR{{ run.proposedAdrs.length > 1 ? 's propostos esperam' : ' proposto espera' }}
              a sua decisão na aba ADRs e conhecimento.
            </p>
          }

          @if (run.context.length > 0) {
            <div>
              <p class="small muted">Contexto do projeto que os agentes consultaram:</p>
              <ul class="sources">
                @for (hit of run.context; track hit.documentId) {
                  <li class="small">{{ hit.title }}</li>
                }
              </ul>
            </div>
          }
        </div>
      }
    </section>
  `,
  styles: `
    :host {
      display: grid;
      gap: var(--gap);
      align-content: start;
    }
    .examples,
    .checklist,
    .sources {
      margin: 6px 0 0;
      padding: 0;
      list-style: none;
    }
    .examples li {
      display: grid;
      gap: 2px;
      margin-top: 8px;
      justify-items: start;
    }
    .checklist li {
      display: flex;
      gap: 10px;
      padding: 8px 0;
      border-top: 1px solid var(--line);
    }
    .checklist li:first-child {
      border-top: 0;
    }
    .mark {
      flex: none;
      width: 26px;
      height: 26px;
      border: 2px solid var(--line);
      border-radius: 50%;
      color: var(--ink-soft);
      font-weight: 600;
      line-height: 22px;
      text-align: center;
    }
    li[data-state='running'] .mark {
      border-color: var(--hold);
      background: var(--hold-bg);
      color: var(--hold);
    }
    li[data-state='done'] .mark {
      border-color: var(--clear);
      background: var(--clear);
      color: #fff;
    }
    .duration {
      margin-left: 6px;
    }
    .sources li {
      padding-left: 12px;
      border-left: 2px solid var(--line);
      margin-top: 4px;
    }
  `,
})
export class NotesPanel {
  protected readonly store = inject(SpecPilotStore);
  protected readonly examples = EXAMPLES;
  protected readonly agents = AGENTS;
  protected readonly label = adrLabel;
  protected readonly stateLabel = { waiting: 'aguardando', running: 'rodando', done: 'concluído' };
  protected readonly notes = signal('');

  protected run(): Promise<void> {
    return this.store.ingest(this.notes());
  }

  /** Um clique: preenche a nota e já roda o workflow. */
  protected runExample(example: ExampleNote): Promise<void> {
    this.notes.set(example.notes);
    return this.run();
  }
}
