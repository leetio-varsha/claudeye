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

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const SETTINGS_PATH = join(homedir(), '.claudeye', 'settings.json');

function getSettings() {
  if (!existsSync(SETTINGS_PATH)) return {};
  try { return JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')); }
  catch { return {}; }
}

let _client = null;
function getClient() {
  if (_client) return _client;
  const apiKey = getSettings().anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('[mem] ANTHROPIC_API_KEY not set');
  _client = new Anthropic({ apiKey });
  return _client;
}

const SYSTEM_PROMPT = `You are a coding session memory assistant. Your job is to compress tool usage events into structured, searchable observations.

Given a tool name, its input, and its output, produce a JSON object with:
- "summary": 1-3 sentences describing what happened and why it matters. Be specific: include file names, function names, errors, decisions. Write as if explaining to a developer returning to this project after 2 weeks.
- "tags": array of 2-5 lowercase tags (e.g. ["bugfix", "auth", "database", "api", "config", "refactor", "security"])
- "importance": float 0.0–1.0 (1.0 = critical decision/fix, 0.5 = routine edit, 0.1 = noise like 'ls')

Respond ONLY with valid JSON. No markdown, no explanation.

Rules:
- Skip noise: if the tool is "Bash" and command is just ls/pwd/cat/echo, set importance ≤ 0.1
- Highlight errors and fixes: if there's an error in the output, importance ≥ 0.8
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
    const client = getClient();
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Project: ${project}
Tool: ${tool}
Input: ${truncatedInput}
Output: ${truncatedOutput}`,
      }],
    });

    const text = response.content[0]?.text?.trim() ?? '';
    const parsed = JSON.parse(text);

    return {
      summary:    String(parsed.summary   || '').slice(0, 500),
      tags:       Array.isArray(parsed.tags) ? parsed.tags.slice(0, 8) : [],
      importance: Math.min(1, Math.max(0, parseFloat(parsed.importance) || 0.5)),
    };
  } catch (err) {
    // Fallback: simple rule-based compression
    console.error('[mem:compress] AI failed, using fallback:', err.message);
    return fallbackCompress(tool, truncatedInput, truncatedOutput);
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
    const client = getClient();
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Summarize this coding session for project "${project}" in 3-5 sentences. Focus on: what was built/fixed, key decisions, any unresolved issues. Be specific.

Session observations:
${topObs}`,
      }],
    });

    return response.content[0]?.text?.trim() ?? null;
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

function fallbackCompress(tool, input, output) {
  const hasError = /error|Error|exception|failed|FAILED/i.test(output);
  const summary  = `[${tool}] ${input.slice(0, 150)}${output ? ` → ${output.slice(0, 100)}` : ''}`;
  return {
    summary,
    tags:       [tool.toLowerCase(), hasError ? 'error' : 'general'],
    importance: hasError ? 0.8 : 0.4,
  };
}
