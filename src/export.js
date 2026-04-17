/**
 * src/export.js — Export memory as Markdown (#11)
 *
 * Produces a single .md file grouped by session, with per-session metadata
 * (project, friction, duration, prompt count) and observations
 * (tool, summary, tags, importance). Optional filters: project, since-date.
 *
 * Usage from CLI:
 *   claudeye export                                         # everything → ./claudeye-export-YYYY-MM-DD.md
 *   claudeye export --project ~/code/foo                    # filter by project (substring match)
 *   claudeye export --since 2026-04-01                      # only sessions started on/after date
 *   claudeye export --output /tmp/snapshot.md               # custom path
 *   claudeye export --include-raw                           # include raw_input/raw_output
 *   claudeye export --no-git                                # skip git-commit observations
 */

import { writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getDb } from './db.js';

const DEFAULT_DIR = process.cwd();

function _shortProject(project) {
  if (!project) return 'unknown';
  return project.replace(homedir(), '~');
}

function _formatDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function _formatDuration(ms) {
  if (!ms || ms <= 0) return '–';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const h = (min / 60).toFixed(1);
  return `${h}h`;
}

function _safeJsonParse(s, fallback) {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

/**
 * Build the export payload from the DB.
 *
 * @param {object} opts
 * @param {string|null} opts.project    — substring match against sessions.project
 * @param {string|null} opts.since      — ISO date 'YYYY-MM-DD' (inclusive)
 * @param {boolean} opts.includeGit     — include git-commit observations (default true)
 * @param {boolean} opts.includeRaw     — include raw_input/raw_output (default false)
 * @param {number} opts.maxObsPerSession — safety cap (default 500)
 * @returns {{ sessions: Array, totals: object }}
 */
export function buildExportPayload({
  project = null,
  since = null,
  includeGit = true,
  includeRaw = false,
  maxObsPerSession = 500,
} = {}) {
  const db = getDb();

  // Build WHERE conditions for sessions
  const sessionWhere = [];
  const sessionParams = [];

  if (project) {
    sessionWhere.push('s.project LIKE ?');
    sessionParams.push(`%${project}%`);
  }
  if (since) {
    sessionWhere.push("s.started_at >= ?");
    sessionParams.push(since);
  }

  const sessionSql = `
    SELECT
      s.id, s.project, s.started_at, s.ended_at, s.summary,
      s.prompt_count, s.friction_score, s.duration_ms,
      s.model, s.token_input, s.token_output, s.outcome
    FROM sessions s
    ${sessionWhere.length ? `WHERE ${sessionWhere.join(' AND ')}` : ''}
    ORDER BY s.started_at ASC
  `;

  const sessions = db.prepare(sessionSql).all(...sessionParams);

  // Per-session observations
  const obsBaseFilter = includeGit ? '' : "AND tool != 'git-commit'";
  const obsSelectCols = includeRaw
    ? `id, tool, summary, tags, importance, decision_rationale, created_at, raw_input, raw_output`
    : `id, tool, summary, tags, importance, decision_rationale, created_at`;

  const obsStmt = db.prepare(`
    SELECT ${obsSelectCols}
    FROM observations
    WHERE session_id = ? ${obsBaseFilter}
    ORDER BY created_at ASC
    LIMIT ?
  `);

  const result = {
    sessions: [],
    totals: {
      sessions: 0,
      observations: 0,
      projects: new Set(),
      since,
      project,
      includeGit,
      includeRaw,
      generatedAt: new Date().toISOString(),
    },
  };

  for (const s of sessions) {
    const obs = obsStmt.all(s.id, maxObsPerSession);
    result.totals.observations += obs.length;
    result.totals.projects.add(s.project);
    result.sessions.push({ session: s, observations: obs });
  }

  result.totals.sessions = result.sessions.length;
  result.totals.projects = result.totals.projects.size;

  return result;
}

/**
 * Render the export payload as Markdown.
 */
export function renderMarkdown(payload) {
  const { sessions, totals } = payload;
  const lines = [];

  lines.push(`# Claudeye Memory Export`);
  lines.push('');
  lines.push(`Generated: \`${totals.generatedAt}\``);
  if (totals.project) lines.push(`Project filter: \`${totals.project}\``);
  if (totals.since)   lines.push(`Since: \`${totals.since}\``);
  lines.push(`Sessions: **${totals.sessions}** · Observations: **${totals.observations}** · Projects: **${totals.projects}**`);
  if (!totals.includeGit) lines.push(`_git-commit observations excluded_`);
  if (totals.includeRaw)  lines.push(`_raw input/output included_`);
  lines.push('');
  lines.push('---');
  lines.push('');

  if (sessions.length === 0) {
    lines.push('_No sessions matched the filters._');
    lines.push('');
    return lines.join('\n');
  }

  // Table of contents
  lines.push('## Sessions');
  lines.push('');
  for (const { session: s } of sessions) {
    const day = s.started_at ? _formatDate(s.started_at) : '????-??-??';
    lines.push(`- [\`${s.id}\`](#session-${s.id.replace(/[^a-z0-9]/gi, '-').toLowerCase()}) — ${day} · ${_shortProject(s.project)}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Per-session sections
  for (const { session: s, observations } of sessions) {
    const anchor = s.id.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    lines.push(`## Session \`${s.id}\``);
    lines.push(`<a id="session-${anchor}"></a>`);
    lines.push('');
    lines.push(`- **Project:** ${_shortProject(s.project)}`);
    lines.push(`- **Started:** ${s.started_at || '–'}`);
    lines.push(`- **Ended:** ${s.ended_at || '_open_'}`);
    lines.push(`- **Duration:** ${_formatDuration(s.duration_ms)}`);
    lines.push(`- **Prompts:** ${s.prompt_count ?? 0}`);
    lines.push(`- **Friction:** ${s.friction_score != null ? s.friction_score.toFixed(3) : '–'}`);
    if (s.model)        lines.push(`- **Model:** ${s.model}`);
    if (s.token_input || s.token_output) {
      lines.push(`- **Tokens:** in=${s.token_input ?? 0} / out=${s.token_output ?? 0}`);
    }
    if (s.outcome)      lines.push(`- **Outcome:** ${s.outcome}`);
    lines.push('');

    if (s.summary) {
      lines.push('### Summary');
      lines.push('');
      lines.push(s.summary.trim());
      lines.push('');
    }

    if (observations.length === 0) {
      lines.push('_No observations._');
      lines.push('');
      continue;
    }

    lines.push(`### Observations (${observations.length})`);
    lines.push('');
    for (const o of observations) {
      const tags = _safeJsonParse(o.tags, []);
      const imp  = (o.importance ?? 0).toFixed(2);
      const tagStr = tags.length ? `\`${tags.join('\`, \`')}\`` : '';
      lines.push(`- **${o.tool}** · imp=${imp}${tagStr ? ` · ${tagStr}` : ''} · _${o.created_at}_`);
      // Indent multi-line summary
      const summary = (o.summary || '').trim();
      if (summary) {
        for (const line of summary.split('\n')) {
          lines.push(`  - ${line}`);
        }
      }
      if (o.decision_rationale) {
        lines.push(`  - 🧠 _decision:_ ${o.decision_rationale.trim().split('\n').join(' ')}`);
      }
      if (o.raw_input) {
        lines.push('');
        lines.push('  ```');
        lines.push('  ' + (o.raw_input.length > 500 ? o.raw_input.slice(0, 500) + '…' : o.raw_input).split('\n').join('\n  '));
        lines.push('  ```');
      }
      if (o.raw_output) {
        lines.push('');
        lines.push('  ```');
        lines.push('  ' + (o.raw_output.length > 500 ? o.raw_output.slice(0, 500) + '…' : o.raw_output).split('\n').join('\n  '));
        lines.push('  ```');
      }
    }

    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Run the export end-to-end and write a file.
 *
 * @returns {{ outputPath: string, sessions: number, observations: number, sizeBytes: number }}
 */
export function runExport({
  project = null,
  since = null,
  output = null,
  includeGit = true,
  includeRaw = false,
} = {}) {
  const payload = buildExportPayload({ project, since, includeGit, includeRaw });
  const md = renderMarkdown(payload);

  const today = new Date().toISOString().slice(0, 10);
  const outputPath = output || join(DEFAULT_DIR, `claudeye-export-${today}.md`);

  writeFileSync(outputPath, md, 'utf8');
  return {
    outputPath,
    sessions: payload.totals.sessions,
    observations: payload.totals.observations,
    projects: payload.totals.projects,
    sizeBytes: Buffer.byteLength(md, 'utf8'),
  };
}
