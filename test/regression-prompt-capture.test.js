/**
 * regression-prompt-capture.test.js — Класс рецидивов: import-lag живых метрик.
 *
 * Симптом: `ClaudeCodeUserPrompt` замер на 2 631 (last obs 2026-07-08) на 8 дней,
 * пока live tool-obs (Bash/Read/Edit) текли нормально. Причина: этот observation
 * писал ТОЛЬКО backfill-скрипт транскриптов (import-driven метрика), а живого
 * capture в inject-hook не было. Анализатор принял артефакт каденса импорта за
 * мёртвый UserPromptSubmit-хук и выкатил нерелевантный ABI-пин.
 *
 * Фикс: inject-hook.js пишет ClaudeCodeUserPrompt в реальном времени (как
 * PostToolUse пишет tool-obs), с dedup против повторной отправки промпта.
 *
 * Тест: (1) mirror-логика capture (insert + dedup + importance/tags);
 *       (2) source drift-guard — сам хук действительно так и делает.
 *
 * Тестируем на in-memory схеме — не трогаем ~/.claudeye/mem.db.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));

function buildSchema(db) {
  db.exec(`
    CREATE TABLE observations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL,
      project     TEXT,
      tool        TEXT NOT NULL,
      summary     TEXT NOT NULL,
      raw_input   TEXT,
      raw_output  TEXT,
      tags        TEXT DEFAULT '[]',
      importance  REAL NOT NULL DEFAULT 0.5,
      decision_rationale TEXT,
      duration_ms INTEGER,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

// Mirror of inject-hook.js live prompt capture: dedup vs the session's last obs,
// then insert with the same shape (tool, tags, word-count importance).
function capturePrompt(db, { sessionId, project, prompt }) {
  const promptText = (prompt || '').trim();
  if (!promptText) return { inserted: false };
  // isConsecutiveDuplicate parity: same tool + same raw_input as last row in session
  const last = db.prepare(
    'SELECT tool, raw_input FROM observations WHERE session_id = ? ORDER BY id DESC LIMIT 1'
  ).get(sessionId);
  if (last && last.tool === 'ClaudeCodeUserPrompt' && last.raw_input === promptText.slice(0, 2000)) {
    return { inserted: false };
  }
  const wc = promptText.split(/\s+/).length;
  db.prepare(`
    INSERT INTO observations (session_id, project, tool, summary, raw_input, tags, importance)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, project, 'ClaudeCodeUserPrompt', promptText.slice(0, 500), promptText.slice(0, 2000),
    JSON.stringify(['claude-code', 'user', 'live']), wc <= 5 ? 0.2 : 0.55);
  return { inserted: true };
}

describe('regression: live ClaudeCodeUserPrompt capture (import-lag fix)', () => {
  it('пишет obs на новый промпт', () => {
    const db = new Database(':memory:');
    buildSchema(db);
    const r = capturePrompt(db, { sessionId: 's1', project: '/p', prompt: 'a fairly substantial prompt about the roadmap and dependencies' });
    assert.equal(r.inserted, true);
    const row = db.prepare("SELECT tool, tags, importance FROM observations WHERE session_id='s1'").get();
    assert.equal(row.tool, 'ClaudeCodeUserPrompt');
    assert.deepEqual(JSON.parse(row.tags), ['claude-code', 'user', 'live']);
    assert.equal(row.importance, 0.55); // >5 слов
  });

  it('dedup: повтор того же промпта подряд не создаёт вторую строку', () => {
    const db = new Database(':memory:');
    buildSchema(db);
    capturePrompt(db, { sessionId: 's1', project: '/p', prompt: 'run the tests' });
    capturePrompt(db, { sessionId: 's1', project: '/p', prompt: 'run the tests' });
    const n = db.prepare("SELECT COUNT(*) n FROM observations WHERE session_id='s1'").get().n;
    assert.equal(n, 1);
  });

  it('короткий промпт (<=5 слов) → importance 0.2', () => {
    const db = new Database(':memory:');
    buildSchema(db);
    capturePrompt(db, { sessionId: 's1', project: '/p', prompt: 'fix it now' });
    const row = db.prepare("SELECT importance FROM observations WHERE session_id='s1'").get();
    assert.equal(row.importance, 0.2);
  });

  it('пустой промпт не пишется', () => {
    const db = new Database(':memory:');
    buildSchema(db);
    const r = capturePrompt(db, { sessionId: 's1', project: '/p', prompt: '   ' });
    assert.equal(r.inserted, false);
  });

  // Source drift-guard: реальный хук должен писать ClaudeCodeUserPrompt через
  // saveObservation под защитой isConsecutiveDuplicate — иначе mirror выше
  // молча разойдётся с продом (тот же класс, что 8-дневная заморозка).
  it('drift-guard: inject-hook.js реально делает live-capture', () => {
    const src = readFileSync(join(__dir, '..', 'hooks', 'inject-hook.js'), 'utf8');
    assert.match(src, /isConsecutiveDuplicate/, 'должен импортировать/использовать dedup-guard');
    assert.match(src, /saveObservation\(/, 'должен вызывать saveObservation');
    assert.match(src, /tool:\s*'ClaudeCodeUserPrompt'/, 'должен писать ClaudeCodeUserPrompt');
    assert.match(src, /'claude-code',\s*'user',\s*'live'/, "тег 'live' отличает от 'backfill'");
  });
});
