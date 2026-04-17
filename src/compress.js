/**
 * compress.js — AI-powered observation compression via Claude
 *
 * Takes raw tool input/output and produces a structured summary:
 * { summary, tags, importance }
 *
 * Importance scale:
 *   0.9+ = architectural decisions, bug fixes, config changes
 *   0.7  = feature implementation, schema changes
 *   0.5  = routine code edits
 *   0.3  = reads, searches, minor tasks
 *   0.1  = noise (ls, cat, pwd)
 */

import { execFileSync, execSync } from 'child_process';
import { existsSync } from 'fs';

// Resolve claude binary at module load time — hooks run with minimal PATH.
//
// IMPORTANT: ~/Library/Application Support/Claude/claude-code-vm/<ver>/claude
// is NOT the user-facing CLI. It is a Linux aarch64 ELF binary used by
// Claude Code's internal sandbox VM and produces ENOEXEC when spawned on
// macOS. Using it caused 100% compress fallbacks (observed via hook_errors
// log 2026-04-17: spawnSync … /claude-code-vm/2.1.111/claude ENOEXEC).
//
// Resolution order (first spawnable wins):
//   1. $CLAUDE_BIN override
//   2. ~/.local/bin/claude (current default install location, symlinked
//      to ~/.local/share/claude/versions/<ver>/claude — Mach-O arm64)
//   3. Homebrew paths
//   4. `which claude` fallback via minimal PATH
export function resolveClaude() {
  const home = process.env.HOME || '';
  const candidates = [
    process.env.CLAUDE_BIN,
    home && `${home}/.local/bin/claude`,
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    'claude',
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      if (c === 'claude') {
        execSync('which claude', { stdio: 'ignore' });
        return c;
      }
      if (!existsSync(c)) continue;
      // Validate spawnability — catches ENOEXEC (wrong arch/OS binary) and
      // ensures we don't cache a broken path. 2s is plenty for --version.
      execFileSync(c, ['--version'], { stdio: 'ignore', timeout: 2000 });
      return c;
    } catch { /* try next candidate */ }
  }
  return 'claude';
}
const CLAUDE_BIN = resolveClaude();

const SYSTEM_PROMPT = `You are a coding session memory assistant. Your job is to compress tool usage events into structured, searchable observations.

Given a tool name, its input, and its output, produce a JSON object with:
- "summary": 1-3 sentences describing what happened and why it matters. Be specific: include file names, function names, errors, decisions. Write as if explaining to a developer returning to this project after 2 weeks.
- "tags": array of 2-5 lowercase tags (e.g. ["bugfix", "auth", "database", "api", "config", "refactor", "security", "decision"])
- "importance": float 0.0–1.0 (1.0 = critical decision/fix, 0.5 = routine edit, 0.1 = noise like 'ls')
- "decision_rationale": if this event contains an architectural decision, technology choice, design trade-off, or explicit "why" reasoning — extract it as a 1-2 sentence rationale. Examples: "Chose better-sqlite3 over sql.js because sandbox can compile native modules", "Switched from REST to WebSocket for real-time updates due to polling overhead". If no decision is present, set to null.

Respond ONLY with valid JSON. No markdown, no explanation.

Rules:
- Skip noise: if the tool is "Bash" and command is just ls/pwd/cat/echo, set importance ≤ 0.1
- Highlight errors and fixes: if there's an error in the output, importance ≥ 0.8
- If a decision rationale is found, add "decision" to tags and set importance ≥ 0.8
- Be specific about file paths and function names
- Extract the "so what" — why does this matter for the project?`;

/**
 * Compress a tool event into a structured observation.
 * Returns { summary, tags, importance } or a fallback if AI fails.
 */
export async function compressObservation({ tool, input, output, project }) {
  const truncatedInput  = (input  || '').slice(0, 3000);
  const truncatedOutput = (output || '').slice(0, 3000);

  // Fast path: skip obvious noise without calling AI
  if (isNoise(tool, truncatedInput)) {
    return {
      summary: `[${tool}] ${truncatedInput.slice(0, 100)}`,
      tags: ['noise'],
      importance: 0.05,
    };
  }

  try {
    const userMsg = `Project: ${project}\nTool: ${tool}\nInput: ${truncatedInput}\nOutput: ${truncatedOutput}`;
    const prompt = `${SYSTEM_PROMPT}\n\n${userMsg}`;

    // Pass prompt via stdin to avoid ARG_MAX limits on large tool outputs (#52)
    const text = execFileSync(CLAUDE_BIN, ['--print', '-m', 'haiku', '--max-tokens', '300', '-'], {
      input: prompt,
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    // Extract JSON from response (claude --print may wrap in markdown)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    const parsed = JSON.parse(jsonMatch[0]);

    const tags = Array.isArray(parsed.tags) ? parsed.tags.slice(0, 8) : [];
    let importance = Math.min(1, Math.max(0, parseFloat(parsed.importance) || 0.5));
    const decisionRationale = parsed.decision_rationale ? String(parsed.decision_rationale).slice(0, 500) : null;

    // Importance boost for decisions (#25)
    if (decisionRationale && importance < 0.8) importance = 0.8;
    if (decisionRationale && !tags.includes('decision')) tags.push('decision');

    return {
      summary:    String(parsed.summary   || '').slice(0, 500),
      tags,
      importance,
      decisionRationale,
      aiCompressed: true,
    };
  } catch (err) {
    // Fallback: simple rule-based compression
    console.error('[mem:compress] AI failed, using fallback:', err.message);
    const fb = fallbackCompress(tool, truncatedInput, truncatedOutput);
    fb.aiCompressed = false;
    fb.fallbackReason = err.message?.slice(0, 200);
    return fb;
  }
}

/**
 * Compress a full session into a summary paragraph.
 */
export async function compressSession({ observations, project }) {
  if (!observations.length) return null;

  const topObs = observations
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 20)
    .map(o => `- [${o.tool}] ${o.summary}`)
    .join('\n');

  try {
    const prompt = `Summarize this coding session for project "${project}" in 3-5 sentences. Focus on: what was built/fixed, key decisions, any unresolved issues. Be specific.\n\nSession observations:\n${topObs}`;

    // Pass prompt via stdin to avoid ARG_MAX limits (#52)
    return execFileSync(CLAUDE_BIN, ['--print', '-m', 'haiku', '--max-tokens', '400', '-'], {
      input: prompt,
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim() || null;
  } catch {
    return `Session with ${observations.length} observations in ${project}.`;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

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

function parseToolInput(input) {
  try { return JSON.parse(input); } catch { return null; }
}

function shortPath(p) {
  if (!p) return '';
  const parts = String(p).split('/');
  return parts.slice(-2).join('/');
}

function fallbackCompress(tool, input, output) {
  const hasError = /error|Error|exception|failed|FAILED/i.test(output);
  const parsed   = parseToolInput(input);
  let summary, tags, importance;

  switch (tool) {
    case 'Edit': {
      const file    = shortPath(parsed?.file_path);
      const snippet = (parsed?.old_string || '').slice(0, 60).replace(/\s+/g, ' ').trim();
      summary    = `Edited ${file}: replaced "${snippet}…"`;
      tags       = ['edit', file.split('.').pop() || 'code'];
      importance = 0.5;
      break;
    }
    case 'Write': {
      const file  = shortPath(parsed?.file_path);
      const lines = (parsed?.content || '').split('\n').length;
      summary    = `Wrote ${file} (${lines} lines)`;
      tags       = ['write', file.split('.').pop() || 'code'];
      importance = 0.6;
      break;
    }
    case 'Read': {
      const file   = shortPath(parsed?.file_path);
      const offset = parsed?.offset ? ` at line ${parsed.offset}` : '';
      summary    = `Read ${file}${offset}`;
      tags       = ['read'];
      importance = 0.3;
      break;
    }
    case 'Grep': {
      const pattern = (parsed?.pattern || '').slice(0, 50);
      const path    = shortPath(parsed?.path || parsed?.glob);
      summary    = `Searched for "${pattern}"${path ? ` in ${path}` : ''}`;
      tags       = ['search'];
      importance = 0.3;
      break;
    }
    case 'Bash': {
      const cmd  = (input || '').slice(0, 100).trim();
      summary    = `Ran: ${cmd}`;
      tags       = ['bash', hasError ? 'error' : 'general'];
      importance = hasError ? 0.8 : 0.3;
      break;
    }
    default: {
      summary    = `[${tool}] ${(input || '').slice(0, 100)}`;
      tags       = [tool.toLowerCase(), 'general'];
      importance = 0.4;
    }
  }

  if (hasError) {
    const reason = extractErrorReason(output);
    summary    += ` → ERROR: ${reason.slice(0, 120)}`;
    importance  = Math.max(importance, 0.8);
    if (!tags.includes('error')) tags.push('error');
  }

  return { summary, tags, importance, decisionRationale: null };
}

/**
 * Best-effort extraction of a human-readable reason from a tool's raw output.
 * Tool results often arrive as JSON envelopes like
 *   {"type":"text","file":{"filePath":"...","content":"..."}}
 * or contain an embedded "Error: ..." line. Pull something useful instead of
 * dumping the wrapper.
 */
function extractErrorReason(output) {
  const text = String(output || '');
  if (!text) return '(no output)';
  // 1. JSON envelopes
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      const o = JSON.parse(m[0]);
      const cand = o.message || o.error || (o.file && (o.file.error || o.file.message));
      if (cand && typeof cand === 'string') return cand.trim();
      if (o?.file?.filePath && /not\s*found|ENOENT|does not exist/i.test(text)) {
        return `file not found: ${o.file.filePath}`;
      }
    }
  } catch {}
  // 2. Error: ... line
  const err = text.match(/(?:^|\n)\s*(?:Error|ENOENT|EACCES|TypeError|ReferenceError)[^\n]{0,160}/);
  if (err) return err[0].trim();
  // 3. First non-JSON line
  const firstLine = text.split('\n').find(l => l.trim() && !l.trim().startsWith('{'));
  if (firstLine) return firstLine.trim();
  return text.slice(0, 120);
}
