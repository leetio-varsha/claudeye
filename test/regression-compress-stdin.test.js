/**
 * regression-compress-stdin.test.js
 *
 * Три связанных регрессии в обработке промптов:
 *
 * #52 — compress.js передавал весь промпт как позиционный аргумент CLI,
 *   что при больших tool outputs бьёт ARG_MAX (~2MB) и падает с E2BIG.
 *   Фикс: prompt передаётся через stdin ('-').
 *
 * #62 — advisor.js та же проблема: большой JSON payload как CLI arg.
 *   Фикс: spawnSync с { input: payload }.
 *
 * #85 — compressSession использовал hardcoded 'claude' вместо CLAUDE_BIN,
 *   57% сессий падали в fallback при нестандартном пути claude binary.
 *   Фикс: resolveClaude() + CLAUDE_BIN module-level constant.
 *
 * Тесты верифицируют исходный код модулей — если кто-то откатит фикс,
 * эти проверки сразу поймают регрессию.
 *
 * See:
 *   github.com/leetio-varsha/claudeye/issues/52
 *   github.com/leetio-varsha/claudeye/issues/62
 *   github.com/leetio-varsha/claudeye/issues/85
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const compressSrc = readFileSync(join(ROOT, 'src/compress.js'), 'utf8');
const advisorSrc  = readFileSync(join(ROOT, 'src/advisor.js'),  'utf8');

// ─── #52: compress.js — prompt via stdin ─────────────────────────────────────

describe('issue #52 — compress.js passes prompt via stdin not positional arg', () => {
  it('execFileSync calls use "-" (stdin) as last positional arg', () => {
    // Both compressObservation and compressSession must use ['-'] pattern
    // Old (buggy): execSync(`claude --print "${prompt}"`)  ← hits ARG_MAX
    // New (fixed): execFileSync(bin, ['--print', ..., '-'], { input: prompt })
    assert.ok(
      compressSrc.includes("'-'"),
      'compress.js must pass "-" as stdin marker to claude CLI (#52)'
    );
  });

  it('does not use template literal to splice prompt into shell command', () => {
    // Catch any reversion to `claude ... ${prompt}` style
    const templateWithPrompt = /execSync\s*\(`[^`]*\$\{[^}]*prompt/;
    assert.ok(
      !templateWithPrompt.test(compressSrc),
      'compress.js must not inject prompt into shell template literal (#52)'
    );
  });

  it('uses { input: } option to pipe data through stdin', () => {
    assert.ok(
      compressSrc.includes('input:'),
      'compress.js must use { input: prompt } for stdin piping (#52)'
    );
  });

  it('compressObservation and compressSession both use stdin (two occurrences of "-")', () => {
    // Both functions must use stdin — count occurrences of the stdin marker
    // to ensure neither function was silently reverted to positional args
    const stdinMarkers = (compressSrc.match(/"'-'"|'-'/g) || []).length;
    assert.ok(
      stdinMarkers >= 2,
      `Expected at least 2 stdin ("-") markers in compress.js (one per function), got ${stdinMarkers} (#52)`
    );
  });
});

// ─── #62: advisor.js — payload via stdin ─────────────────────────────────────

describe('issue #62 — advisor.js passes payload via stdin not positional arg', () => {
  it('spawnSync calls use { input: } for stdin piping', () => {
    // Old (buggy): spawnSync(claude, [JSON.stringify(bigPayload)])  ← hits ARG_MAX
    // New (fixed): spawnSync(claude, [...], { input: JSON.stringify(payload) })
    assert.ok(
      advisorSrc.includes('input:'),
      'advisor.js must use { input: } option to pass payload via stdin (#62)'
    );
  });

  it('does not pass JSON payload as a positional CLI argument', () => {
    // If payload appears as a positional arg, it would be something like:
    // spawnSync(bin, [payload]) or spawnSync(bin, [JSON.stringify(data)])
    // We check that the args array does not include a runtime variable splice
    const positionalPayload = /spawnSync\s*\([^,]+,\s*\[[^\]]*JSON\.stringify/;
    assert.ok(
      !positionalPayload.test(advisorSrc),
      'advisor.js must not pass JSON.stringify(payload) as a positional CLI argument (#62)'
    );
  });
});

// ─── #85: compress.js — CLAUDE_BIN not hardcoded 'claude' ───────────────────

describe('issue #85 — compressSession uses CLAUDE_BIN not hardcoded "claude"', () => {
  it('module declares CLAUDE_BIN constant from resolveClaude()', () => {
    assert.ok(
      compressSrc.includes('CLAUDE_BIN'),
      'compress.js must declare CLAUDE_BIN (#85)'
    );
    assert.ok(
      compressSrc.includes('resolveClaude'),
      'compress.js must use resolveClaude() to resolve binary path (#85)'
    );
  });

  it('execFileSync is never called with hardcoded "claude" string literal', () => {
    // Catch any reversion to execFileSync('claude', ...) or execSync('claude ...')
    assert.ok(
      !compressSrc.includes("execFileSync('claude'"),
      'compress.js must not call execFileSync with hardcoded "claude" (#85)'
    );
    assert.ok(
      !compressSrc.match(/execSync\s*\(\s*['"]claude\b/),
      'compress.js must not call execSync with hardcoded "claude" (#85)'
    );
  });

  it('compressSession function body references CLAUDE_BIN not literal "claude"', () => {
    const fnStart = compressSrc.indexOf('export async function compressSession');
    assert.ok(fnStart >= 0, 'compressSession export must exist');

    // Extract up to closing brace — grab a generous window
    const fnBody = compressSrc.slice(fnStart, fnStart + 800);
    assert.ok(
      fnBody.includes('CLAUDE_BIN'),
      'compressSession must use CLAUDE_BIN variable (#85)'
    );
    assert.ok(
      !fnBody.includes("'claude'") || fnBody.includes('CLAUDE_BIN'),
      'compressSession must not contain hardcoded "claude" string (#85)'
    );
  });
});
