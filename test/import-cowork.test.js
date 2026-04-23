/**
 * Unit tests for Cowork noise filter + intra-session dedup + assistant
 * text-block bundling (#93).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  isNoiseEvent,
  dedupEvents,
  parseTranscript,
} from '../src/import-cowork.js';

describe('isNoiseEvent (#93)', () => {
  test('drops empty TodoWrite', () => {
    assert.equal(isNoiseEvent({ kind: 'tool', tool: 'TodoWrite', input: '{"todos":[]}' }), true);
  });

  test('keeps non-empty TodoWrite', () => {
    assert.equal(isNoiseEvent({ kind: 'tool', tool: 'TodoWrite', input: '{"todos":[{"content":"fix"}]}' }), false);
  });

  test('drops empty-input service tools', () => {
    for (const t of [
      'mcp__computer-use__screenshot',
      'mcp__scheduled-tasks__list_scheduled_tasks',
      'mcp__session_info__list_sessions',
    ]) {
      assert.equal(isNoiseEvent({ kind: 'tool', tool: t, input: '{}' }), true, `${t} {} should be noise`);
    }
  });

  test('keeps screenshot if input has content', () => {
    assert.equal(
      isNoiseEvent({ kind: 'tool', tool: 'mcp__computer-use__screenshot', input: '{"window":"safari"}' }),
      false,
    );
  });

  test('drops short user prompts', () => {
    for (const t of ['Да', 'нет', 'ok', 'No response requested.', '  go  ']) {
      assert.equal(isNoiseEvent({ kind: 'user', text: t }), true, `"${t}" should be noise`);
    }
  });

  test('keeps substantive user prompts', () => {
    assert.equal(
      isNoiseEvent({ kind: 'user', text: 'Создай issue в GitHub для этого бага' }),
      false,
    );
  });

  test('drops tiny assistant replies', () => {
    assert.equal(isNoiseEvent({ kind: 'assistant', text: 'ok' }), true);
    assert.equal(isNoiseEvent({ kind: 'assistant', text: 'done' }), true);
  });

  test('keeps full assistant responses', () => {
    assert.equal(
      isNoiseEvent({ kind: 'assistant', text: 'Я проверил БД и нашёл 3 ошибки в compress_fallback. Детали ниже.' }),
      false,
    );
  });
});

describe('dedupEvents (#93)', () => {
  test('drops identical tool calls within a session', () => {
    const input = [
      { kind: 'tool', tool: 'Bash', input: 'git status' },
      { kind: 'tool', tool: 'Bash', input: 'git status' },
      { kind: 'tool', tool: 'Bash', input: 'git status' },
      { kind: 'tool', tool: 'Read', input: '{"file_path":"a.js"}' },
    ];
    const { events, dropped } = dedupEvents(input);
    assert.equal(events.length, 2);
    assert.equal(dropped, 2);
  });

  test('does not dedup user or assistant events', () => {
    const input = [
      { kind: 'user', text: 'fix it' },
      { kind: 'user', text: 'fix it' },
      { kind: 'assistant', text: 'applied patch' },
      { kind: 'assistant', text: 'applied patch' },
    ];
    const { events, dropped } = dedupEvents(input);
    assert.equal(events.length, 4);
    assert.equal(dropped, 0);
  });

  test('keeps first occurrence', () => {
    const input = [
      { kind: 'tool', tool: 'Bash', input: 'ls', ts: '1' },
      { kind: 'tool', tool: 'Bash', input: 'ls', ts: '2' },
    ];
    const { events } = dedupEvents(input);
    assert.equal(events[0].ts, '1');
  });
});

describe('parseTranscript assistant bundling (#93)', () => {
  let tmp;
  test.before(() => { tmp = mkdtempSync(join(tmpdir(), 'claudeye-test-')); });
  test.after(() => { rmSync(tmp, { recursive: true, force: true }); });

  test('bundles multiple text blocks of one assistant turn', () => {
    const path = join(tmp, 'transcript.jsonl');
    const lines = [
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-04-23T00:00:00Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Часть 1' },
            { type: 'text', text: 'Часть 2' },
            { type: 'text', text: 'Часть 3' },
          ],
        },
      }),
    ];
    writeFileSync(path, lines.join('\n'));
    const events = parseTranscript(path);
    const assistants = events.filter(e => e.kind === 'assistant');
    assert.equal(assistants.length, 1, 'three text blocks should bundle into one event');
    assert.ok(assistants[0].text.includes('Часть 1'));
    assert.ok(assistants[0].text.includes('Часть 3'));
  });

  test('pairs tool_use with tool_result', () => {
    const path = join(tmp, 'transcript2.jsonl');
    const lines = [
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-04-23T00:00:00Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-04-23T00:00:01Z',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: 'file1\nfile2' },
          ],
        },
      }),
    ];
    writeFileSync(path, lines.join('\n'));
    const events = parseTranscript(path);
    const tools = events.filter(e => e.kind === 'tool');
    assert.equal(tools.length, 1);
    assert.equal(tools[0].tool, 'Bash');
    assert.equal(tools[0].output, 'file1\nfile2');
  });
});
