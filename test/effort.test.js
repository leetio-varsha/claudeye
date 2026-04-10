/**
 * test/effort.test.js — Tests for rule-based effort classification
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyEffort } from '../src/effort.js';

// ─── Returns null for short messages ────────────────────────────────────

describe('Effort Classification', () => {
  it('returns null for messages with < 10 words', () => {
    assert.equal(classifyEffort('fix typo'), null);
    assert.equal(classifyEffort('hello'), null);
    assert.equal(classifyEffort(''), null);
    assert.equal(classifyEffort(null), null);
    assert.equal(classifyEffort(undefined), null);
  });

  // ─── Low effort ─────────────────────────────────────────────────────

  it('classifies typo fix as low', () => {
    const r = classifyEffort('Исправь опечатку в файле src/db.js на строке 42 где написано tabel вместо table');
    assert.equal(r.effort, 'low');
    assert.ok(r.confidence >= 0.7);
  });

  it('classifies rename as low', () => {
    const r = classifyEffort('Переименуй функцию getData в fetchUserData в этом файле чтобы было понятнее что она делает');
    assert.equal(r.effort, 'low');
    assert.ok(r.confidence >= 0.7);
  });

  it('rename across all files escalates to high', () => {
    const r = classifyEffort('Переименуй функцию getData в fetchUserData во всех файлах проекта чтобы было понятнее');
    assert.equal(r.effort, 'high');
  });

  it('classifies formatting as low', () => {
    const r = classifyEffort('Прогони eslint и prettier на всех файлах в директории src и исправь все ошибки форматирования');
    assert.equal(r.effort, 'low');
    assert.ok(r.confidence >= 0.7);
  });

  // ─── High effort ────────────────────────────────────────────────────

  it('classifies debugging as high', () => {
    const r = classifyEffort('Почему приложение падает при обработке больших файлов? В логах вижу OOM error но не могу понять где утечка памяти');
    assert.equal(r.effort, 'high');
    assert.ok(r.confidence >= 0.7);
  });

  it('classifies architecture as high', () => {
    const r = classifyEffort('Нужно спроектировать архитектуру для нового модуля аналитики с учетом масштабируемости и производительности');
    assert.equal(r.effort, 'high');
    assert.ok(r.confidence >= 0.7);
  });

  it('classifies performance optimization as high', () => {
    const r = classifyEffort('Оптимизируй запросы к базе данных потому что страница грузится очень медленно и пользователи жалуются');
    assert.equal(r.effort, 'high');
    assert.ok(r.confidence >= 0.7);
  });

  it('classifies stack trace analysis as high', () => {
    const msg = `Почему падает эта ошибка и как её исправить:
Error: SQLITE_CONSTRAINT: NOT NULL constraint failed
    at Database.prepare (/app/src/db.js:42:15)
    at saveObservation (/app/src/db.js:187:20)
    at main (/app/hooks/save-hook.js:89:5)`;
    const r = classifyEffort(msg);
    assert.equal(r.effort, 'high');
    assert.ok(r.confidence >= 0.7);
  });

  it('classifies security review as high', () => {
    const r = classifyEffort('Проверь безопасность нашего API на предмет уязвимостей типа injection и XSS в обработчиках запросов');
    assert.equal(r.effort, 'high');
    assert.ok(r.confidence >= 0.7);
  });

  // ─── Medium effort ──────────────────────────────────────────────────

  it('classifies feature addition as medium', () => {
    const r = classifyEffort('Добавь новое поле email в форму регистрации пользователей с валидацией и сохранением в базу данных');
    assert.equal(r.effort, 'medium');
  });

  it('classifies test writing as medium', () => {
    const r = classifyEffort('Напиши тесты для модуля effort classification чтобы покрыть основные кейсы и edge cases');
    assert.equal(r.effort, 'medium');
    assert.ok(r.confidence >= 0.5);
  });

  it('classifies config changes as medium', () => {
    const r = classifyEffort('Обнови конфигурацию проекта для работы с новой версией Node.js и добавь правильные env переменные');
    assert.equal(r.effort, 'medium');
    assert.ok(r.confidence >= 0.5);
  });

  // ─── Edge cases ─────────────────────────────────────────────────────

  it('no patterns → defaults to medium with low confidence', () => {
    const r = classifyEffort('Расскажи мне подробно про историю создания языка программирования и его основные особенности пожалуйста');
    assert.equal(r.effort, 'medium');
    assert.ok(r.confidence <= 0.5);
  });

  it('mixed signals — high wins with debugging context', () => {
    const r = classifyEffort('Дебаг и рефактор модуля аутентификации — нужно разобраться почему не работает OAuth и переписать полностью');
    assert.equal(r.effort, 'high');
  });
});
