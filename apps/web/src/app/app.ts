import { ChangeDetectionStrategy, Component, inject, type OnInit, signal } from '@angular/core';
import { Board } from './board';
import { Copilot } from './copilot';
import { Knowledge } from './knowledge';
import { MetricsBar } from './metrics-bar';
import { NotesPanel } from './notes-panel';
import { SpecPilotStore } from './store';

type Tab = 'board' | 'knowledge' | 'copilot';

/** A moldura da aplicação: marca, as três áreas, o modo em que a API está rodando e as métricas. */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Board, Copilot, Knowledge, MetricsBar, NotesPanel],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  protected readonly store = inject(SpecPilotStore);
  protected readonly tab = signal<Tab>('board');

  ngOnInit(): void {
    void this.load();
  }

  /** `pnpm dev` abre a tela antes de a API terminar de subir: a primeira carga insiste um pouco. */
  private async load(attempts = 8): Promise<void> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (await this.store.refresh()) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
