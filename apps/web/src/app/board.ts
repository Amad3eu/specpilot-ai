import { CdkDrag, type CdkDragDrop, CdkDropList, CdkDropListGroup } from '@angular/cdk/drag-drop';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import type { UserStory } from '@specpilot/shared-schemas';
import { type BoardColumn, SpecPilotStore } from './store';
import { StoryStrip } from './story-strip';

const COLUMNS: Array<{ status: BoardColumn; title: string; empty: string }> = [
  {
    status: 'pending_approval',
    title: 'Pending Approval',
    empty: 'Nada esperando aprovação. Histórias de alto impacto ou baixa confiança param aqui.',
  },
  { status: 'ready', title: 'Ready', empty: 'Nenhuma história pronta. Gere um backlog ou aprove uma pendente.' },
  { status: 'in_progress', title: 'In Progress', empty: 'Arraste uma história de Ready para cá.' },
  { status: 'done', title: 'Done', empty: 'Nada concluído ainda.' },
];

/**
 * O board Kanban. As três colunas da direita aceitam arrastar e soltar; a primeira é a fila
 * de aprovação humana, e dela só se sai pelo botão Aprovar ou Rejeitar.
 */
@Component({
  selector: 'app-board',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CdkDropListGroup, CdkDropList, CdkDrag, StoryStrip],
  template: `
    <div class="approver">
      <label for="approver">Quem aprova</label>
      <input
        id="approver"
        type="text"
        [value]="approver()"
        (input)="approver.set($any($event.target).value)"
        placeholder="Seu nome"
      />
      <span class="small muted">O nome fica na trilha de auditoria de cada aprovação.</span>
    </div>

    <div class="bays" cdkDropListGroup>
      @for (column of columns; track column.status) {
        @let stories = store.columns()[column.status];
        <section class="bay" [attr.data-status]="column.status" [attr.aria-labelledby]="'bay-' + column.status">
          <h3 [id]="'bay-' + column.status">
            {{ column.title }} <span class="count">{{ stories.length }}</span>
          </h3>
          <div
            class="strips"
            cdkDropList
            [cdkDropListData]="column.status"
            [cdkDropListEnterPredicate]="accepts(column.status)"
            (cdkDropListDropped)="drop($event)"
          >
            @for (story of stories; track story.id) {
              <app-story-strip
                cdkDrag
                [cdkDragData]="story"
                [cdkDragDisabled]="story.status === 'pending_approval'"
                [story]="story"
                [epic]="store.epicTitles()[story.epicId] ?? ''"
                (approve)="store.approve(story, approverName())"
                (reject)="store.reject(story)"
                (move)="store.move(story, $event)"
              />
            } @empty {
              <p class="empty small muted">{{ column.empty }}</p>
            }
          </div>
        </section>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .approver {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
    }
    .approver label {
      margin: 0;
    }
    .approver input {
      width: 220px;
    }
    .bays {
      display: grid;
      grid-template-columns: repeat(4, minmax(230px, 1fr));
      gap: 12px;
      overflow-x: auto;
      padding-bottom: 8px;
    }
    .bay {
      min-width: 0;
      border-top: 4px solid var(--landed);
      background: var(--landed-bg);
    }
    .bay[data-status='pending_approval'] {
      border-top-color: var(--hold);
      background: var(--hold-bg);
    }
    .bay[data-status='ready'] {
      border-top-color: var(--clear);
      background: var(--clear-bg);
    }
    .bay[data-status='in_progress'] {
      border-top-color: var(--enroute);
      background: var(--enroute-bg);
    }
    h3 {
      padding: 10px 12px 6px;
    }
    .count {
      margin-left: 4px;
      color: var(--ink-soft);
      font-family: var(--font);
      font-size: 0.95rem;
      font-weight: 500;
    }
    .strips {
      display: grid;
      gap: 8px;
      align-content: start;
      min-height: 120px;
      padding: 6px 8px 12px;
    }
    .empty {
      padding: 8px 4px;
    }
  `,
})
export class Board {
  protected readonly store = inject(SpecPilotStore);
  protected readonly columns = COLUMNS;
  protected readonly approver = signal('');

  protected approverName(): string {
    return this.approver().trim() || 'pessoa revisora';
  }

  /** A fila de aprovação não recebe card arrastado: ninguém volta para lá, nem entra sem o gate. */
  protected accepts(status: BoardColumn) {
    return (_drag: CdkDrag) => status !== 'pending_approval';
  }

  protected drop(event: CdkDragDrop<BoardColumn, BoardColumn, UserStory>): void {
    const target = event.container.data;
    if (event.previousContainer === event.container || target === 'pending_approval') return;
    void this.store.move(event.item.data, target);
  }
}
