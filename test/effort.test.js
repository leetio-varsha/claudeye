/**
 * test/effort.test.js — Tests for rule-based effort classification
 *
 * Run: node test/effort.test.js
 */

import { classifyEffort } from '../src/effort.js';
import assert from 'node:assert/strict';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ─── Returns null for short messages ─────────────────────────────────────────

test('returns null for messages with < 10 words', () => {
  assert.equal(classifyEffort('fix typo'), null);
  assert.equal(classifyEffort('hello'), null);
  assert.equal(classifyEffort(''), null);
  assert.equal(classifyEffort(null), null);
  assert.equal(classifyEffort(undefined), null);
});

// ─── Low effort detection ────────────────────────────────────────────────────

test('classifies typo fix as low', () => {
  const r = classifyEffort('Исправь опечатку в файле src/db.js на строке 42 где написано tabel вместо table');
  assert.equal(r.effort, 'low');
  assert.ok(r.confidence >= 0.7);
});

test('classifies rename as low', () => {
  const r = classifyEffort('Переименуй функцию getData в fetchUserData в этом файле чтобы было понятнее что она делает');
  assert.equal(r.effort, 'low');
  assert.ok(r.confidence >= 0.7);
});

test('rename across all files escalates to high (complex scope)', () => {
  const r = classifyEffort('Переименуй функцию getData в fetchUserData во всех файлах проекта чтобы было понятнее');
  // "во всех файлах" triggers high — correct, this is a complex multi-file operation
  assert.equal(r.effort, 'high');
});

test('classifies formatting as low', () => {
  const r = classifyEffort('Прогони eslint и prettier на всех файлах в директории src и исправь все ошибки форматирования');
  assert.equal(r.effort, 'low');
  assert.ok(r.confidence >= 0.7);
});

// ─── High effort detection ───────────────────────────────────────────────────

test('classifies debugging as high', () => {
  const r = classifyEffort('Почему приложение падает при обработке больших файлов? В логах вижу OOM error но не могу понять где утечка памяти');
  assert.equal(r.effort, 'high');
  assert.ok(r.confidence >= 0.7);
});

test('classifies architecture as high', () => {
  const r = classifyEffort('Нужно спроектировать архитектуру для нового модуля аналитики с учетом масштабируемости и производительности');
  assert.equal(r.effort, 'high');
  assert.ok(r.confidence >= 0.7);
});

test('classifies performance optimization as high', () => {
  const r = classifyEffort('Оптимизируй запросы к базе данных потому что страница грузится очень медленно и пользователи жалуются');
  assert.equal(r.effort, 'high');
  assert.ok(r.confidence >= 0.7);
});

test('classifies stack trace analysis as high', () => {
  const msg = `Почему падает эта ошибка и как её исправить:
Error: SQLITE_CONSTRAINT: NOT NULL constraint failed
    at Database.prepare (/app/src/db.js:42:15)
    at saveObservation (/app/src/db.js:187:20)
    at main (/app/hooks/save-hook.js:89:5)`;
  const r = classifyEffort(msg);
  assert.equal(r.effort, 'high');
  assert.ok(r.confidence >= 0.7);
});

test('classifies security review as high', () => {
  const r = classifyEffort('Проверь безопасность нашего API на предмет уязвимостей типа injection и XSS в обработчиках запросов');
  assert.equal(r.effort, 'high');
  assert.ok(r.confidence >= 0.7);
});

// ─── Medium effort detection ─────────────────────────────────────────────────

test('classifies feature addition as medium', () => {
  const r = classifyEffort('Добавь новое поле email в форму регистрации пользователей с валидацией и сохранением в базу данных');
  assert.equal(r.effort, 'medium');
  // May be low confidence (tie) or medium — both acceptable
});

test('classifies test writing as medium', () => {
  const r = classifyEffort('Напиши тесты для модуля effort classification чтобы покрыть основные кейсы и edge cases');
  assert.equal(r.effort, 'medium');
  assert.ok(r.confidence >= 0.5);
});

test('classifies config changes as medium', () => {
  const r = classifyEffort('Обнови конфигурацию проекта для работы с новой версией Node.js и добавь правильные env переменные');
  assert.equal(r.effort, 'medium');
  assert.ok(r.confidence >= 0.5);
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

test('no patterns matched → defaults to medium with low confidence', () => {
  const r = classifyEffort('Расскажи мне подробно про историю создания языка программирования и его основные особенности пожалуйста');
  assert.equal(r.effort, 'medium');
  assert.ok(r.confidence <= 0.5);
});

test('mixed signals — high wins with debugging context', () => {
  const r = classifyEffort('Дебаг и рефактор модуля аутентификации — нужно разобраться почему не работает OAuth и переписать полностью');
  assert.equal(r.effort, 'high');
});

// ─── Run all ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

for (const t of tests) {
  try {
    t.fn();
    passed++;
    console.log(`  ✓ ${t.name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${t.name}`);
    console.log(`    ${err.message}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
