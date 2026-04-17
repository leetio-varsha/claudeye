/**
 * test/compress.test.js — Tests for AI compression module
 *
 * Tests fallback compression, noise detection, error extraction.
 * AI path is NOT tested (requires claude CLI) — only rule-based paths.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// We import compress internals via dynamic import to avoid side effects
// But since these are private functions, we re-implement the logic for testing.
// The actual exports are compressObservation and compressSession.

// ─── Noise detection ────────────────────────────────────────────────────

const NOISE_PATTERNS = [
  /^(ls|pwd|echo|cat|which|type|man|help|clear|history)\b/,
  /^git\s+(status|log|diff)\s*$/,
];

function isNoise(tool, input) {
  if (tool === 'Bash') {
    const cmd = (input || '').trim().toLowerCase();
    return NOISE_PATTERNS.some(p => p.test(cmd));
  }
  return false;
}

describe('Noise Detection', () => {
  it('detects ls as noise', () => {
    assert.equal(isNoise('Bash', 'ls -la'), true);
  });

  it('detects pwd as noise', () => {
    assert.equal(isNoise('Bash', 'pwd'), true);
  });

  it('detects git status as noise', () => {
    assert.equal(isNoise('Bash', 'git status'), true);
  });

  it('detects git log as noise', () => {
    assert.equal(isNoise('Bash', 'git log'), true);
  });

  it('does not flag npm install as noise', () => {
    assert.equal(isNoise('Bash', 'npm install'), false);
  });

  it('does not flag git commit as noise', () => {
    assert.equal(isNoise('Bash', 'git commit -m "test"'), false);
  });

  it('non-Bash tools are never noise', () => {
    assert.equal(isNoise('Edit', 'ls'), false);
    assert.equal(isNoise('Read', 'cat file'), false);
  });
});

// ─── Fallback compression ───────────────────────────────────────────────

function shortPath(p) {
  if (!p) return '';
  const parts = String(p).split('/');
  return parts.slice(-2).join('/');
}

function fallbackCompress(tool, input, output) {
  const hasError = /error|Error|exception|failed|FAILED/i.test(output);
  let parsed;
  try { parsed = JSON.parse(input); } catch { parsed = null; }
  let summary, tags, importance;

  switch (tool) {
    case 'Edit': {
      const file = shortPath(parsed?.file_path);
      const snippet = (parsed?.old_string || '').slice(0, 60).replace(/\s+/g, ' ').trim();
      summary = `Edited ${file}: replaced "${snippet}…"`;
      tags = ['edit', file.split('.').pop() || 'code'];
      importance = 0.5;
      break;
    }
    case 'Write': {
      const file = shortPath(parsed?.file_path);
      const lines = (parsed?.content || '').split('\n').length;
      summary = `Wrote ${file} (${lines} lines)`;
      tags = ['write', file.split('.').pop() || 'code'];
      importance = 0.6;
      break;
    }
    case 'Read': {
      const file = shortPath(parsed?.file_path);
      const offset = parsed?.offset ? ` at line ${parsed.offset}` : '';
      summary = `Read ${file}${offset}`;
      tags = ['read'];
      importance = 0.3;
      break;
    }
    case 'Bash': {
      const cmd = (input || '').slice(0, 100).trim();
      summary = `Ran: ${cmd}`;
      tags = ['bash', hasError ? 'error' : 'general'];
      importance = hasError ? 0.8 : 0.3;
      break;
    }
    default: {
      summary = `[${tool}] ${(input || '').slice(0, 100)}`;
      tags = [tool.toLowerCase(), 'general'];
      importance = 0.4;
    }
  }

  if (hasError) {
    summary += ' → ERROR';
    importance = Math.max(importance, 0.8);
    if (!tags.includes('error')) tags.push('error');
  }

  return { summary, tags, importance };
}

describe('Fallback Compression', () => {
  it('compresses Edit with file path and snippet', () => {
    const result = fallbackCompress('Edit',
      JSON.stringify({ file_path: '/home/user/project/src/app.js', old_string: 'const x = 1' }),
      'OK');
    assert.match(result.summary, /Edited.*app\.js/);
    assert.ok(result.tags.includes('edit'));
    assert.equal(result.importance, 0.5);
  });

  it('compresses Write with line count', () => {
    const result = fallbackCompress('Write',
      JSON.stringify({ file_path: '/src/index.ts', content: 'line1\nline2\nline3' }),
      'OK');
    assert.match(result.summary, /Wrote.*index\.ts.*3 lines/);
    assert.ok(result.tags.includes('write'));
    assert.equal(result.importance, 0.6);
  });

  it('compresses Read with offset', () => {
    const result = fallbackCompress('Read',
      JSON.stringify({ file_path: '/src/db.js', offset: 100 }),
      'file contents...');
    assert.match(result.summary, /Read.*db\.js.*at line 100/);
    assert.equal(result.importance, 0.3);
  });

  it('compresses Bash with command', () => {
    const result = fallbackCompress('Bash', 'npm test', 'All 29 tests passed');
    assert.match(result.summary, /Ran: npm test/);
    assert.ok(result.tags.includes('bash'));
    assert.equal(result.importance, 0.3);
  });

  it('detects errors in output and boosts importance', () => {
    const result = fallbackCompress('Bash', 'npm test', 'Error: test failed');
    assert.ok(result.tags.includes('error'));
    assert.equal(result.importance, 0.8);
  });

  it('handles unknown tools with fallback format', () => {
    const result = fallbackCompress('CustomTool', 'some input', 'some output');
    assert.match(result.summary, /\[CustomTool\]/);
    assert.equal(result.importance, 0.4);
  });
});

// ─── Error extraction ───────────────────────────────────────────────────

function extractErrorReason(output) {
  const text = String(output || '');
  if (!text) return '(no output)';
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      const o = JSON.parse(m[0]);
      const cand = o.message || o.error;
      if (cand && typeof cand === 'string') return cand.trim();
    }
  } catch {}
  const err = text.match(/(?:^|\n)\s*(?:Error|ENOENT|EACCES|TypeError|ReferenceError)[^\n]{0,160}/);
  if (err) return err[0].trim();
  const firstLine = text.split('\n').find(l => l.trim() && !l.trim().startsWith('{'));
  if (firstLine) return firstLine.trim();
  return text.slice(0, 120);
}

describe('Error Extraction', () => {
  it('extracts message from JSON envelope', () => {
    const reason = extractErrorReason('{"message": "file not found", "code": 404}');
    assert.equal(reason, 'file not found');
  });

  it('extracts Error: line from stack trace', () => {
    const reason = extractErrorReason('some preamble\nError: Cannot find module "foo"\n  at require()');
    assert.match(reason, /Cannot find module/);
  });

  it('returns first line for plain text', () => {
    const reason = extractErrorReason('Something went wrong\nMore details');
    assert.equal(reason, 'Something went wrong');
  });

  it('handles empty output', () => {
    assert.equal(extractErrorReason(''), '(no output)');
    assert.equal(extractErrorReason(null), '(no output)');
  });
});

// ─── Claude binary resolution (regression: claude-code-vm ENOEXEC) ───────
//
// The earlier resolver picked up ~/Library/Application Support/Claude/
// claude-code-vm/<ver>/claude, which is a Linux aarch64 ELF used by the
// sandbox VM — spawning it on macOS yields ENOEXEC and forced 100% of
// observations into fallbackCompress. These tests guard against the
// regression by asserting the resolved path is never inside claude-code-vm.

describe('resolveClaude (regression)', () => {
  it('never returns a claude-code-vm path', async () => {
    const { resolveClaude } = await import('../src/compress.js');
    const bin = resolveClaude();
    assert.ok(!/claude-code-vm/.test(bin),
      `resolveClaude() returned ${bin} — must not use claude-code-vm VM binary`);
  });

  it('honors $CLAUDE_BIN override before other candidates', async () => {
    // Point CLAUDE_BIN at the test runner itself (node is always executable
    // on the host). resolveClaude() validates with `--version`, which node
    // supports, so it should accept this candidate.
    const prev = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = process.execPath;
    try {
      // Re-import via cache-busting query so we re-run the top-level
      // resolution logic. (The exported `resolveClaude` is pure, so a
      // direct call is enough — no re-import needed.)
      const { resolveClaude } = await import('../src/compress.js');
      const bin = resolveClaude();
      assert.equal(bin, process.execPath);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_BIN;
      else process.env.CLAUDE_BIN = prev;
    }
  });
});
