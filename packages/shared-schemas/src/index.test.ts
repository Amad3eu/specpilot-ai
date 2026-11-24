import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ApprovalRequest,
  adrLabel,
  BOARD_COLUMNS,
  IndexDocumentRequest,
  IngestRequest,
  MoveStoryRequest,
  STREAM_EVENT_TYPES,
  StoryStatus,
  StreamEvent,
} from './index.js';

test('as colunas do board são os status, menos rejected, na ordem do fluxo', () => {
  assert.deepEqual([...BOARD_COLUMNS], ['pending_approval', 'ready', 'in_progress', 'done']);
  assert.deepEqual(
    StoryStatus.options.filter((status) => !(BOARD_COLUMNS as readonly string[]).includes(status)),
    ['rejected'],
  );
});

test('a lista de tipos de evento que o front usa é a mesma do schema do stream', () => {
  const fromSchema = StreamEvent.options.map((option) => option.shape.type.value);
  assert.deepEqual([...STREAM_EVENT_TYPES].sort(), [...fromSchema].sort());
});

test('adrLabel: três dígitos, e número grande não é cortado', () => {
  assert.deepEqual([adrLabel(1), adrLabel(42), adrLabel(1234)], ['ADR-001', 'ADR-042', 'ADR-1234']);
});

test('IngestRequest: tira espaço das pontas e recusa nota curta demais, com o motivo', () => {
  assert.deepEqual(IngestRequest.parse({ notes: '  O cliente precisa pagar com PIX.  ' }), {
    notes: 'O cliente precisa pagar com PIX.',
  });
  const short = IngestRequest.safeParse({ notes: '   curta   ' });
  assert.equal(short.success, false);
  assert.match(short.error?.issues[0]?.message ?? '', /Cole pelo menos uma frase/);
});

test('MoveStoryRequest: ninguém move um card para a fila de aprovação nem para rejected', () => {
  for (const status of ['ready', 'in_progress', 'done'])
    assert.equal(MoveStoryRequest.safeParse({ status }).success, true);
  for (const status of ['pending_approval', 'rejected', 'outro']) {
    assert.equal(MoveStoryRequest.safeParse({ status }).success, false, status);
  }
});

test('valores padrão: aprovação sem nome e documento sem tipo', () => {
  assert.deepEqual(ApprovalRequest.parse({}), { approvedBy: 'pessoa revisora' });
  assert.equal(
    IndexDocumentRequest.parse({ title: 'Guia de deploy', content: 'O deploy passa pelo pipeline e exige aprovação.' })
      .kind,
    'doc',
  );
});
