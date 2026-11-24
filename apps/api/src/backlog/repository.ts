import { randomUUID } from 'node:crypto';
import type {
  AcceptanceCriterion,
  Adr,
  AdrStatus,
  AuditLog,
  Epic,
  Level,
  StoryStatus,
  UserStory,
} from '@specpilot/shared-schemas';
import type { Database } from '../db/database.js';

// Tudo o que lê e grava backlog, ADRs e auditoria. Só SQL e mapeamento de linha para contrato:
// regra de negócio (quem pode aprovar, para onde um card pode ir) fica em services.ts.

interface StoryRow {
  id: string;
  epic_id: string;
  title: string;
  as_a: string;
  i_want: string;
  so_that: string;
  acceptance_criteria: AcceptanceCriterion[];
  priority: Level;
  impact: Level;
  confidence: number;
  status: StoryStatus;
  approval_reasons: string[];
  approved_by: string | null;
  created_at: Date;
}

interface AdrRow extends Omit<Adr, 'createdAt'> {
  created_at: Date;
}

const iso = (date: Date) => new Date(date).toISOString();

const toStory = (row: StoryRow): UserStory => ({
  id: row.id,
  epicId: row.epic_id,
  title: row.title,
  asA: row.as_a,
  iWant: row.i_want,
  soThat: row.so_that,
  acceptanceCriteria: row.acceptance_criteria,
  priority: row.priority,
  impact: row.impact,
  // REAL volta com ruído de ponto flutuante (0.6 vira 0.6000000238): duas casas bastam.
  confidence: Math.round(row.confidence * 100) / 100,
  status: row.status,
  approvalReasons: row.approval_reasons,
  approvedBy: row.approved_by,
  createdAt: iso(row.created_at),
});

const toAdr = ({ created_at, ...adr }: AdrRow): Adr => ({ ...adr, createdAt: iso(created_at) });

export type NewStory = Omit<UserStory, 'id' | 'createdAt' | 'approvedBy'>;

export type BacklogRepository = ReturnType<typeof createBacklogRepository>;

export function createBacklogRepository(db: Database) {
  return {
    // --- Épicos e histórias -------------------------------------------------------------------

    /** Devolve o épico com este título, criando se não existir: a mesma reunião não duplica épico. */
    async upsertEpic(title: string, summary: string): Promise<Epic> {
      const existing = await db.query<{ id: string; title: string; summary: string; created_at: Date }>(
        'SELECT id, title, summary, created_at FROM epics WHERE lower(title) = lower($1)',
        [title],
      );
      const row =
        existing.rows[0] ??
        (
          await db.query<{ id: string; title: string; summary: string; created_at: Date }>(
            'INSERT INTO epics (id, title, summary) VALUES ($1, $2, $3) RETURNING id, title, summary, created_at',
            [randomUUID(), title, summary],
          )
        ).rows[0];
      if (!row) throw new Error('O banco não devolveu o épico gravado.');
      return { id: row.id, title: row.title, summary: row.summary, createdAt: iso(row.created_at) };
    },

    async storyExists(epicId: string, title: string): Promise<boolean> {
      const { rows } = await db.query('SELECT 1 FROM stories WHERE epic_id = $1 AND lower(title) = lower($2)', [
        epicId,
        title,
      ]);
      return rows.length > 0;
    },

    async insertStory(story: NewStory): Promise<UserStory> {
      const { rows } = await db.query<StoryRow>(
        `INSERT INTO stories (id, epic_id, title, as_a, i_want, so_that, acceptance_criteria,
                              priority, impact, confidence, status, approval_reasons)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12::jsonb)
         RETURNING *`,
        [
          randomUUID(),
          story.epicId,
          story.title,
          story.asA,
          story.iWant,
          story.soThat,
          // Lista vai como texto JSON: o driver do Postgres converteria um array em array do banco.
          JSON.stringify(story.acceptanceCriteria),
          story.priority,
          story.impact,
          story.confidence,
          story.status,
          JSON.stringify(story.approvalReasons),
        ],
      );
      if (!rows[0]) throw new Error('O banco não devolveu a história gravada.');
      return toStory(rows[0]);
    },

    async listEpics(): Promise<Epic[]> {
      const { rows } = await db.query<{ id: string; title: string; summary: string; created_at: Date }>(
        'SELECT id, title, summary, created_at FROM epics ORDER BY created_at, title',
      );
      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        summary: row.summary,
        createdAt: iso(row.created_at),
      }));
    },

    async listStories(status?: StoryStatus): Promise<UserStory[]> {
      const { rows } = await db.query<StoryRow>(
        `SELECT * FROM stories WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at, title`,
        [status ?? null],
      );
      return rows.map(toStory);
    },

    async findStory(id: string): Promise<UserStory | undefined> {
      const { rows } = await db.query<StoryRow>('SELECT * FROM stories WHERE id = $1', [id]);
      return rows[0] ? toStory(rows[0]) : undefined;
    },

    /**
     * Muda o status só se a história ainda estiver em um dos status esperados. A condição vai
     * no próprio UPDATE: duas pessoas aprovando ao mesmo tempo não aprovam duas vezes.
     */
    async transitionStory(
      id: string,
      from: StoryStatus[],
      to: StoryStatus,
      approvedBy: string | null = null,
    ): Promise<UserStory | undefined> {
      const { rows } = await db.query<StoryRow>(
        `UPDATE stories SET status = $2, approved_by = COALESCE($3, approved_by)
         WHERE id = $1 AND status = ANY($4::text[]) RETURNING *`,
        [id, to, approvedBy, from],
      );
      return rows[0] ? toStory(rows[0]) : undefined;
    },

    // --- ADRs ---------------------------------------------------------------------------------

    async listAdrs(status?: AdrStatus): Promise<Adr[]> {
      const { rows } = await db.query<AdrRow>(
        `SELECT id, number, title, status, context, decision, consequences, created_at
         FROM adrs WHERE ($1::text IS NULL OR status = $1) ORDER BY number`,
        [status ?? null],
      );
      return rows.map(toAdr);
    },

    async adrExists(title: string): Promise<boolean> {
      const { rows } = await db.query('SELECT 1 FROM adrs WHERE lower(title) = lower($1)', [title]);
      return rows.length > 0;
    },

    /** O número é o próximo livre, calculado no próprio INSERT. */
    async insertAdr(adr: Pick<Adr, 'title' | 'status' | 'context' | 'decision' | 'consequences'>): Promise<Adr> {
      const { rows } = await db.query<AdrRow>(
        `INSERT INTO adrs (id, number, title, status, context, decision, consequences)
         VALUES ($1, (SELECT COALESCE(MAX(number), 0) + 1 FROM adrs), $2, $3, $4, $5, $6)
         RETURNING id, number, title, status, context, decision, consequences, created_at`,
        [randomUUID(), adr.title, adr.status, adr.context, adr.decision, adr.consequences],
      );
      if (!rows[0]) throw new Error('O banco não devolveu o ADR gravado.');
      return toAdr(rows[0]);
    },

    async transitionAdr(id: string, to: AdrStatus): Promise<Adr | undefined> {
      const { rows } = await db.query<AdrRow>(
        `UPDATE adrs SET status = $2 WHERE id = $1 AND status = 'proposed'
         RETURNING id, number, title, status, context, decision, consequences, created_at`,
        [id, to],
      );
      return rows[0] ? toAdr(rows[0]) : undefined;
    },

    // --- Auditoria ----------------------------------------------------------------------------

    async audit(entry: Omit<AuditLog, 'id' | 'at'>): Promise<void> {
      await db.query(
        'INSERT INTO audit_trail (actor, action, entity_type, entity_id, details) VALUES ($1, $2, $3, $4, $5::jsonb)',
        [entry.actor, entry.action, entry.entityType, entry.entityId, JSON.stringify(entry.details)],
      );
    },

    async listAudit(limit = 100): Promise<AuditLog[]> {
      const { rows } = await db.query<{
        id: string;
        at: Date;
        actor: string;
        action: string;
        entity_type: AuditLog['entityType'];
        entity_id: string;
        details: Record<string, unknown>;
      }>(
        `SELECT id::text AS id, at, actor, action, entity_type, entity_id, details
         FROM audit_trail ORDER BY id DESC LIMIT $1`,
        [limit],
      );
      return rows.map((row) => ({
        id: row.id,
        at: iso(row.at),
        actor: row.actor,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        details: row.details,
      }));
    },
  };
}
