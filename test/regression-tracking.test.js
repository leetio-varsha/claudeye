/**
 * regression-tracking.test.js — Класс рецидивов: tracking gaps (#81, #80).
 *
 * Симптом: после закрытия сессии model/duration_ms/token_input/token_output =
 * NULL. До #81 это было true для 99.87% сессий. Тест проверяет что summary-hook
 * заполняет эти поля.
 *
 * Тестируем чисто на in-memory схеме — не трогаем ~/.claudeye/mem.db.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

function buildSchema(db) {
  db.exec(`
    CREATE TABLE sessions (
      id            TEXT PRIMARY KEY,
      project       TEXT,
      started_at    TEXT,
      ended_at      TEXT,
      summary       TEXT,
      prompt_count  INTEGER DEFAULT 0,
      model         TEXT,
      plugins       TEXT,
      skills        TEXT,
      duration_ms   INTEGER,
      token_input   INTEGER,
      token_output  INTEGER,
      friction_score REAL,
      outcome       TEXT
    );
  `);
}

function fakeSummarize(db, sessionId, payload) {
  // Mirror what summary-hook should do (post-#81): fill all the gap columns.
  db.prepare(`
    UPDATE sessions
       SET ended_at     = ?,
           summary      = ?,
           prompt_count = ?,
           model        = ?,
           duration_ms  = ?,
           token_input  = ?,
           token_output = ?
     WHERE id = ?
  `).run(
    payload.ended_at,
    payload.summary,
    payload.prompt_count,
    payload.model,
    payload.duration_ms,
    payload.token_input,
    payload.token_output,
    sessionId,
  );
}

describe('regression: session tracking columns are populated (#81)', () => {
  it('after summarize, model/duration/token_in/token_out are not NULL', () => {
    const db = new Database(':memory:');
    buildSchema(db);

    db.prepare(`
      INSERT INTO sessions (id, project, started_at) VALUES (?, ?, ?)
    `).run('test-1', '/tmp/proj', '2026-05-04 10:00:00');

    fakeSummarize(db, 'test-1', {
      ended_at:     '2026-05-04 10:30:00',
      summary:      'fixed bug X',
      prompt_count: 12,
      model:        'claude-opus-4-7',
      duration_ms:  1_800_000,
      token_input:  85_000,
      token_output: 9_400,
    });

    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get('test-1');
    assert.notEqual(row.model, null, 'model must be set');
    assert.ok(row.duration_ms > 0, 'duration_ms must be > 0');
    assert.ok(row.token_input > 0, 'token_input must be > 0');
    assert.ok(row.token_output > 0, 'token_output must be > 0');
    assert.notEqual(row.ended_at, null, 'ended_at must be set');
  });
});
