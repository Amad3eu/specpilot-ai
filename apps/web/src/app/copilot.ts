import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { SpecPilotStore } from './store';

const SUGGESTIONS = ['Como é feita a autenticação?', 'Qual banco de dados usamos?', 'O que está pendente no backlog?'];

/** O copiloto: perguntas sobre o backlog e a arquitetura, respondidas com as fontes da base. */
@Component({
  selector: 'app-copilot',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel stack" aria-labelledby="copilot-title">
      <h2 id="copilot-title">Copiloto do projeto</h2>
      <p class="muted">Pergunte sobre o backlog ou sobre as decisões de arquitetura. A resposta cita de onde veio.</p>

      <div class="log" aria-live="polite">
        @for (message of store.chat(); track $index) {
          <div class="message" [attr.data-from]="message.from">
            <p class="small muted">{{ message.from === 'user' ? 'Você' : 'Copiloto' }}</p>
            <p>{{ message.text }}</p>
            @if (message.sources.length > 0) {
              <p class="small muted">
                Fontes:
                @for (source of message.sources; track source.documentId) {
                  <span class="tag">{{ source.title }}</span>
                }
              </p>
            }
          </div>
        } @empty {
          <div class="suggestions">
            <p class="small muted">Para começar:</p>
            @for (suggestion of suggestions; track suggestion) {
              <button class="button quiet small" type="button" (click)="ask(suggestion)">{{ suggestion }}</button>
            }
          </div>
        }
        @if (store.asking()) {
          <p class="muted">Consultando a base…</p>
        }
      </div>

      <form class="row" (submit)="submit($event)">
        <div class="grow">
          <label for="question">Sua pergunta</label>
          <input id="question" type="text" [value]="question()" (input)="question.set($any($event.target).value)" />
        </div>
        <button class="button" type="submit" [disabled]="store.asking() || question().trim().length < 3">Perguntar</button>
      </form>
    </section>
  `,
  styles: `
    :host {
      display: block;
      max-width: 820px;
    }
    .log {
      display: grid;
      gap: 10px;
      min-height: 160px;
    }
    .message {
      max-width: 68ch;
      padding: 10px 12px;
      border-left: 4px solid var(--route);
      background: var(--enroute-bg);
    }
    .message[data-from='user'] {
      justify-self: end;
      border-left-color: var(--landed);
      background: var(--landed-bg);
    }
    .suggestions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
    }
    .row {
      display: flex;
      align-items: end;
      gap: 8px;
    }
    .grow {
      flex: 1;
      min-width: 0;
    }
    .tag {
      margin-left: 4px;
      white-space: normal;
    }
  `,
})
export class Copilot {
  protected readonly store = inject(SpecPilotStore);
  protected readonly suggestions = SUGGESTIONS;
  protected readonly question = signal('');

  protected ask(question: string): Promise<void> {
    this.question.set('');
    return this.store.ask(question);
  }

  protected submit(event: Event): Promise<void> {
    event.preventDefault();
    return this.ask(this.question().trim());
  }
}
