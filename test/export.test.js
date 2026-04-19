/**
 * test/export.test.js — Markdown export (#11)
 *
 * Tests the pure rendering function with hand-built payloads so
 * we don't need to touch the real DB.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'os';
import { renderMarkdown } from '../src/export.js';

// Build project paths anchored to the real homedir so _shortProject()
// replaces the prefix with `~` regardless of OS/user running the tests.
const HOME = homedir();
const ALPHA_PROJECT = `${HOME}/projects/alpha`;
const BETA_PROJECT  = `${HOME}/projects/beta`;

function buildSamplePayload() {
  return {
    totals: {
      sessions: 2,
      observations: 3,
      projects: 2,
      since: '2026-04-01',
      project: null,
      includeGit: true,
      includeRaw: false,
      generatedAt: '2026-04-17T12:00:00.000Z',
    },
    sessions: [
      {
        session: {
          id: 'sess-a',
          project: ALPHA_PROJECT,
          started_at: '2026-04-10 10:00:00',
          ended_at:   '2026-04-10 11:30:00',
          summary: 'Fixed auth bug and cleaned up tests.',
          prompt_count: 12,
          friction_score: 0.215,
          duration_ms: 5_400_000, // 1h30m
          model: 'claude-sonnet-4-6',
          token_input: 15000,
          token_output: 3200,
          outcome: 'success',
        },
        observations: [
          {
            id: 1, tool: 'Edit', summary: 'Updated auth.service.ts\nMinor tweaks.',
            tags: JSON.stringify(['bugfix', 'auth']), importance: 0.8,
            decision_rationale: 'Chose to refactor instead of patching.',
            created_at: '2026-04-10 10:05:00',
          },
          {
            id: 2, tool: 'Bash', summary: 'npm test — all green',
            tags: JSON.stringify(['test']), importance: 0.5,
            decision_rationale: null,
            created_at: '2026-04-10 10:30:00',
          },
        ],
      },
      {
        session: {
          id: 'sess-b',
          project: BETA_PROJECT,
          started_at: '2026-04-12 09:00:00',
          ended_at: null,
          summary: null,
          prompt_count: 3,
          friction_score: 0,
          duration_ms: null,
          model: null,
          token_input: null,
          token_output: null,
          outcome: null,
        },
        observations: [
          {
            id: 3, tool: 'Read', summary: 'Opened README.md',
            tags: null, importance: 0.2,
            decision_rationale: null,
            created_at: '2026-04-12 09:02:00',
          },
        ],
      },
    ],
  };
}

describe('export: renderMarkdown', () => {
  it('emits header with totals and metadata', () => {
    const md = renderMarkdown(buildSamplePayload());
    assert.match(md, /# Claudeye Memory Export/);
    assert.match(md, /Sessions: \*\*2\*\*/);
    assert.match(md, /Observations: \*\*3\*\*/);
    assert.match(md, /Projects: \*\*2\*\*/);
    assert.match(md, /Since: `2026-04-01`/);
  });

  it('includes TOC with session anchors', () => {
    const md = renderMarkdown(buildSamplePayload());
    assert.match(md, /## Sessions/);
    assert.match(md, /\[`sess-a`\]\(#session-sess-a\)/);
    assert.match(md, /\[`sess-b`\]\(#session-sess-b\)/);
  });

  it('renders per-session metadata (duration, friction, tokens, outcome)', () => {
    const md = renderMarkdown(buildSamplePayload());
    assert.match(md, /## Session `sess-a`/);
    assert.match(md, /\*\*Project:\*\* ~\/projects\/alpha/);
    assert.match(md, /\*\*Duration:\*\* 1\.5h/);
    assert.match(md, /\*\*Prompts:\*\* 12/);
    assert.match(md, /\*\*Friction:\*\* 0\.215/);
    assert.match(md, /\*\*Model:\*\* claude-sonnet-4-6/);
    assert.match(md, /\*\*Tokens:\*\* in=15000 \/ out=3200/);
    assert.match(md, /\*\*Outcome:\*\* success/);
  });

  it('handles open/missing session gracefully', () => {
    const md = renderMarkdown(buildSamplePayload());
    assert.match(md, /## Session `sess-b`/);
    assert.match(md, /\*\*Ended:\*\* _open_/);
    assert.match(md, /\*\*Duration:\*\* –/);
  });

  it('renders observations with tool, importance, tags, decision', () => {
    const md = renderMarkdown(buildSamplePayload());
    assert.match(md, /\*\*Edit\*\* · imp=0\.80 · `bugfix`, `auth`/);
    assert.match(md, /🧠 _decision:_ Chose to refactor instead of patching\./);
    assert.match(md, /- Updated auth\.service\.ts/);
    assert.match(md, /- Minor tweaks\./);
  });

  it('shows empty-result message when nothing matches', () => {
    const empty = { sessions: [], totals: {
      sessions: 0, observations: 0, projects: 0,
      since: null, project: 'nosuch',
      includeGit: true, includeRaw: false,
      generatedAt: '2026-04-17T12:00:00.000Z',
    } };
    const md = renderMarkdown(empty);
    assert.match(md, /_No sessions matched the filters\._/);
  });
});

describe('export: renderMarkdown edge cases', () => {
  it('ignores invalid JSON in tags', () => {
    const payload = buildSamplePayload();
    payload.sessions[0].observations[0].tags = 'not-valid-json';
    const md = renderMarkdown(payload);
    assert.ok(md.includes('imp=0.80'));
    // Should not crash, and should omit tag string since tags parsed to []
    assert.doesNotMatch(md, /not-valid-json/);
  });

  it('formats short duration in seconds', () => {
    const payload = buildSamplePayload();
    payload.sessions[0].session.duration_ms = 45_000;
    const md = renderMarkdown(payload);
    assert.match(md, /\*\*Duration:\*\* 45s/);
  });

  it('formats medium duration in minutes', () => {
    const payload = buildSamplePayload();
    payload.sessions[0].session.duration_ms = 1_800_000; // 30m
    const md = renderMarkdown(payload);
    assert.match(md, /\*\*Duration:\*\* 30m/);
  });

  it('note line appears when git excluded', () => {
    const payload = buildSamplePayload();
    payload.totals.includeGit = false;
    const md = renderMarkdown(payload);
    assert.match(md, /_git-commit observations excluded_/);
  });
});
