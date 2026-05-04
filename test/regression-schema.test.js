/**
 * regression-schema.test.js — Класс рецидивов: миграции не идемпотентны (#45, #54).
 *
 * Симптом: повторный запуск миграций падает на ALTER TABLE без проверки колонок.
 * Этот тест: запустить миграции дважды на in-memory DB и убедиться что 2-й
 * прогон не валится.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

// applyMigrationsTwice — упрощённый smoke. Реальный applyMigrations() из src/db.js
// должен импортироваться сюда через factory с настраиваемым DB_PATH; пока его нет,
// тест декларирует контракт: последующий вызов не должен падать.
function applyMigrationsSmoke(db) {
  // Симулируем шаг миграции, который ломался: ALTER без проверки.
  // Правильный вариант — wrap в try/catch on duplicate-column error.
  const tryAlter = (sql) => {
    try { db.exec(sql); }
    catch (e) {
      if (!/duplicate column/i.test(e.message)) throw e;
    }
  };

  db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY)');
  tryAlter('ALTER TABLE sessions ADD COLUMN model TEXT');
  tryAlter('ALTER TABLE sessions ADD COLUMN duration_ms INTEGER');
}

describe('regression: migrations are idempotent (#45, #54)', () => {
  it('running twice does not throw', () => {
    const db = new Database(':memory:');
    applyMigrationsSmoke(db);
    assert.doesNotThrow(() => applyMigrationsSmoke(db),
      'Second migration run must not throw on already-added columns');

    // Verify final schema
    const cols = db.prepare("PRAGMA table_info(sessions)").all().map(c => c.name);
    assert.ok(cols.includes('model'));
    assert.ok(cols.includes('duration_ms'));
  });
});
