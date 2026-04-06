#!/usr/bin/env node
/**
 * hooks/inject-hook.js — UserPromptSubmit hook
 *
 * Called by Claude Code before each user prompt is processed.
 * Prints relevant context to stdout — Claude Code prepends it to the prompt.
 *
 * Claude Code hook contract:
 *   stdin:   JSON { prompt, session_id }
 *   stdout:  text to prepend to the prompt (or empty for no injection)
 *   exit 0:  success
 */

import { readFileSync } from 'fs';

const __dir = new URL('.', import.meta.url).pathname;
const srcDir = __dir + '../src/';

// ─── Session handoff ─────────────────────────────────────────────────────
// Thresholds for warning/handoff injection
const WARN_PROMPT_COUNT = 100;   // soft warning
const HANDOFF_PROMPT_COUNT = 200; // strong recommendation + handoff context

/**
 * Check session length and build handoff context if session is too long.
 * Returns null if session is still short enough.
 */
function buildSessionHandoff(db, sessionId, project) {
  try {
    const session = db.prepare(
      'SELECT prompt_count, started_at FROM sessions WHERE id = ?'
    ).get(sessionId);

    if (!session || session.prompt_count < WARN_PROMPT_COUNT) return null;

    const promptCount = session.prompt_count;
    const isHandoff = promptCount >= HANDOFF_PROMPT_COUNT;
    const lines = [];

    lines.push('<!-- claudeye: session length warning -->');

    if (isHandoff) {
      lines.push(`## ⚠️ Длинная сессия: ${promptCount} промптов`);
      lines.push('');
      lines.push('Эта сессия очень длинная. Контекстное окно заполнено, каждый запрос тратит значительно больше токенов. **Рекомендуется начать новую сессию.**');
      lines.push('');
      lines.push('Claudeye inject-hook автоматически подхватит контекст в новой сессии.');
    } else {
      lines.push(`## ℹ️ Сессия: ${promptCount} промптов`);
      lines.push('');
      lines.push('Сессия становится длинной. Если задача позволяет — рассмотрите начало новой сессии для экономии квоты.');
    }

    // Build handoff: recent high-importance observations from this session
    if (isHandoff) {
      const recentObs = db.prepare(`
        SELECT summary, tool, importance, tags
        FROM observations
        WHERE session_id = ? AND importance >= 0.5
        ORDER BY created_at DESC
        LIMIT 10
      `).all(sessionId);

      const decisions = db.prepare(`
        SELECT decision_rationale
        FROM observations
        WHERE session_id = ? AND decision_rationale IS NOT NULL
        ORDER BY importance DESC
        LIMIT 5
      `).all(sessionId);

      // Files touched in this session
      const files = db.prepare(`
        SELECT DISTINCT
          CASE
            WHEN tool IN ('Edit', 'Write') THEN SUBSTR(raw_input, 1, 200)
            ELSE NULL
          END as file_hint
        FROM observations
        WHERE session_id = ? AND tool IN ('Edit', 'Write') AND raw_input IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 10
      `).all(sessionId).filter(f => f.file_hint);

      // Unfinished work: recent errors or high-importance items
      const errors = db.prepare(`
        SELECT summary FROM observations
        WHERE session_id = ? AND tags LIKE '%error%'
        ORDER BY created_at DESC LIMIT 3
      `).all(sessionId);

      lines.push('');
      lines.push('### Для продолжения в новой сессии, скопируй это:');
      lines.push('');
      lines.push('```');
      lines.push(`Продолжаю работу над ${project.split('/').pop()}.`);
      lines.push('');

      if (recentObs.length) {
        lines.push('Что было сделано в прошлой сессии:');
        for (const o of recentObs.slice(0, 7)) {
          lines.push(`- ${o.summary.slice(0, 150)}`);
        }
        lines.push('');
      }

      if (decisions.length) {
        lines.push('Ключевые решения:');
        for (const d of decisions) {
          lines.push(`- ${d.decision_rationale}`);
        }
        lines.push('');
      }

      if (errors.length) {
        lines.push('Нерешённые проблемы:');
        for (const e of errors) {
          lines.push(`- ${e.summary.slice(0, 150)}`);
        }
        lines.push('');
      }

      if (files.length) {
        lines.push('Файлы с которыми работал:');
        for (const f of files.slice(0, 5)) {
          // Try to extract just the file path
          const pathMatch = f.file_hint.match(/[\/\w.-]+\.\w+/);
          if (pathMatch) lines.push(`- ${pathMatch[0]}`);
        }
        lines.push('');
      }

      lines.push('```');
    }

    lines.push('<!-- end claudeye session warning -->');
    return lines.join('\n');
  } catch {
    return null;
  }
}

async function main() {
  let event;

  try {
    const raw = readFileSync('/dev/stdin', 'utf8');
    event = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const { prompt, session_id: sessionId } = event;

  if (!prompt?.trim()) process.exit(0);

  const project = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Global timeout: never block Claude Code for more than 5 seconds (#55)
  const TIMEOUT_MS = 5000;
  const timeout = setTimeout(() => {
    console.error('[mem:inject] timeout after ' + TIMEOUT_MS + 'ms — skipping injection');
    process.exit(0);
  }, TIMEOUT_MS);

  try {
    const { upsertSession, logHookError, getDb } = await import(srcDir + 'db.js');
    const { buildContext }  = await import(srcDir + 'search.js');

    upsertSession(sessionId, project);

    const context = await buildContext(prompt, project);

    if (context) {
      process.stdout.write(context + '\n\n');
    }

    // Session length warning + handoff
    const handoff = buildSessionHandoff(getDb(), sessionId, project);
    if (handoff) {
      process.stdout.write(handoff + '\n\n');
    }
  } catch (err) {
    try { logHookError('inject-hook', 'general', err.message, project); } catch {}
    // Exit cleanly — don't block Claude Code on memory failure
  }

  clearTimeout(timeout);
  process.exit(0);
}

main();
