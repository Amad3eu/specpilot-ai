import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import type { AdrStatus, DocumentKind } from '@specpilot/shared-schemas';
import { adrLabel } from '@specpilot/shared-schemas/constants';
import { SpecPilotStore } from './store';

const STATUS: Record<AdrStatus, string> = { proposed: 'Proposto', accepted: 'Aceito', rejected: 'Rejeitado' };
const KIND: Record<DocumentKind, string> = { adr: 'ADR', rule: 'Regra', doc: 'Documento' };

/**
 * ADRs e base de conhecimento. O ADR proposto por IA espera aqui a decisão de uma pessoa;
 * aceito, entra na base e passa a ser contexto dos agentes. A busca é a mesma busca híbrida
 * que eles usam, e o formulário indexa um documento novo no RAG.
 */
@Component({
  selector: 'app-knowledge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="stack" aria-labelledby="adrs-title">
      <h2 id="adrs-title">Architecture Decision Records</h2>
      @for (adr of store.adrs(); track adr.id) {
        <article class="adr" [attr.data-status]="adr.status">
          <header>
            <h3>{{ label(adr.number) }}: {{ adr.title }}</h3>
            <span class="tag" [class.hold]="adr.status === 'proposed'" [class.clear]="adr.status === 'accepted'">
              {{ status[adr.status] }}
            </span>
          </header>
          <dl>
            <dt>Contexto</dt>
            <dd>{{ adr.context }}</dd>
            <dt>Decisão</dt>
            <dd>{{ adr.decision }}</dd>
            <dt>Consequências</dt>
            <dd>{{ adr.consequences }}</dd>
          </dl>
          @if (adr.status === 'proposed') {
            <div class="actions">
              <button class="button small" type="button" (click)="store.approveAdr(adr)">Aceitar e indexar</button>
              <button class="button danger small" type="button" (click)="store.rejectAdr(adr)">Rejeitar</button>
            </div>
          }
        </article>
      }
    </section>

    <div class="stack">
      <section class="panel stack" aria-labelledby="search-title">
        <h2 id="search-title">Buscar na base</h2>
        <form class="row" (submit)="search($event)">
          <div class="grow">
            <label for="query">Pergunta ou termo exato</label>
            <input id="query" type="text" [value]="query()" (input)="query.set($any($event.target).value)" placeholder="qual banco de dados usamos?" />
          </div>
          <button class="button" type="submit" [disabled]="query().trim().length < 2">Buscar</button>
        </form>
        @if (store.searchHits(); as hits) {
          <div aria-live="polite">
            @for (hit of hits; track hit.documentId) {
              <article class="hit">
                <h4>{{ hit.title }} <span class="tag">{{ kind[hit.kind] }}</span></h4>
                <p class="small">{{ hit.snippet }}</p>
              </article>
            } @empty {
              <p class="muted">Nada na base sobre isso. Tente outro termo, ou indexe um documento abaixo.</p>
            }
          </div>
        }
      </section>

      <section class="panel stack" aria-labelledby="index-title">
        <h2 id="index-title">Indexar documento</h2>
        <form class="stack" (submit)="index($event)">
          <div class="row">
            <div>
              <label for="kind">Tipo</label>
              <select id="kind" [value]="docKind()" (change)="docKind.set($any($event.target).value)">
                <option value="doc">Documento</option>
                <option value="rule">Regra</option>
                <option value="adr">ADR</option>
              </select>
            </div>
            <div class="grow">
              <label for="title">Título</label>
              <input id="title" type="text" [value]="title()" (input)="title.set($any($event.target).value)" />
            </div>
          </div>
          <div>
            <label for="content">Conteúdo</label>
            <textarea id="content" rows="5" [value]="content()" (input)="content.set($any($event.target).value)"></textarea>
          </div>
          <button class="button" type="submit" [disabled]="title().trim().length < 3 || content().trim().length < 20">
            Indexar na base
          </button>
        </form>

        <div>
          <p class="small muted">{{ store.documents().length }} documentos na base:</p>
          <ul class="documents">
            @for (document of store.documents(); track document.id) {
              <li class="small"><span class="tag">{{ kind[document.kind] }}</span> {{ document.title }}</li>
            }
          </ul>
        </div>
      </section>
    </div>
  `,
  styles: `
    :host {
      display: grid;
      grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
      gap: var(--gap);
      align-items: start;
    }
    @media (max-width: 900px) {
      :host {
        grid-template-columns: minmax(0, 1fr);
      }
    }
    .adr {
      padding: 12px 14px;
      border: 1px solid var(--line);
      border-left: 6px solid var(--clear);
      border-radius: 2px;
      background: var(--panel);
    }
    .adr[data-status='proposed'] {
      border-left-color: var(--hold);
    }
    .adr[data-status='rejected'] {
      border-left-color: var(--landed);
      color: var(--ink-soft);
    }
    .adr header {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 8px;
    }
    dl {
      margin: 8px 0 0;
    }
    dt {
      margin-top: 6px;
      color: var(--ink-soft);
      font-size: 0.85rem;
      font-weight: 600;
    }
    dd {
      margin: 0;
    }
    .actions {
      display: flex;
      gap: 6px;
      margin-top: 10px;
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
    .hit {
      padding: 8px 0;
      border-top: 1px solid var(--line);
    }
    h4 {
      font-weight: 600;
    }
    .documents {
      margin: 6px 0 0;
      padding: 0;
      list-style: none;
    }
    .documents li {
      margin-top: 4px;
    }
  `,
})
export class Knowledge {
  protected readonly store = inject(SpecPilotStore);
  protected readonly label = adrLabel;
  protected readonly status = STATUS;
  protected readonly kind = KIND;

  protected readonly query = signal('');
  protected readonly docKind = signal<DocumentKind>('doc');
  protected readonly title = signal('');
  protected readonly content = signal('');

  protected search(event: Event): Promise<void> {
    event.preventDefault();
    return this.store.search(this.query().trim());
  }

  protected async index(event: Event): Promise<void> {
    event.preventDefault();
    const indexed = await this.store.indexDocument({
      kind: this.docKind(),
      title: this.title().trim(),
      content: this.content().trim(),
    });
    // O formulário só limpa quando o documento entrou: em erro, o texto digitado fica.
    if (indexed) {
      this.title.set('');
      this.content.set('');
    }
  }
}
