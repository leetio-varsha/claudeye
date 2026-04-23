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

/**
 * Smart truncation — cut on a word boundary close to the limit and append "…"
 * (#91). Used in session handoff where aggressive hardcoded slice(0, 150) used
 * to chop details off mid-word exactly when they were most needed for continuing
 * work in a fresh session.
 *
 * If the text fits under the limit, returns it unchanged. Otherwise cuts at the
 * last whitespace in the last 30% of the window so we don't lose too many words.
 */
function truncateSmart(text, limit) {
  if (!text) return '';
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  const boundary = lastSpace > limit * 0.7 ? lastSpace : cut.length;
  return cut.slice(0, boundary).trimEnd() + '…';
}

// Handoff budget per section (#91). Errors get the most because the next
// session will need full context to continue debugging; recent observations
// get less because there are many of them. decisions are never truncated.
const HANDOFF_BUDGET = {
  errors: 250,   // errors need detail; was hardcoded 150
  recent: 200,   // was hardcoded 150
  file:   200,   // path hint for Edit/Write tools
};

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
    // (#87 fix) Read session age from actual observation timestamps, not just
    // prompt_count. Reason: users keep Claude Code open across days, one
    // session_id can span 5+ days with stale context. session.started_at +
    // MAX(o.created_at) gives the true active window.
    const session = db.prepare(
      'SELECT prompt_count, started_at FROM sessions WHERE id = ?'
    ).get(sessionId);

    if (!session) return null;

    const promptCount = session.prompt_count;
    const ageInfo = db.prepare(`
      SELECT
        (julianday('now') - julianday(?))              AS total_days_since_start,
        (SELECT julianday('now') - julianday(MIN(created_at))
         FROM observations WHERE session_id = ?)       AS active_days_since_first_obs
    `).get(session.started_at, sessionId) || {};
    const activeDays = ageInfo.active_days_since_first_obs || ageInfo.total_days_since_start || 0;

    // Triggers: long by prompts OR long by wall-clock days
    const SESSION_STALE_DAYS = 1;    // 🟡 session active > 24h
    const SESSION_FORCE_DAYS = 3;    // 🔴 session active > 3 days = force handoff

    const isLongByPrompts = promptCount >= HANDOFF_PROMPT_COUNT;
    const isWarnByPrompts = promptCount >= WARN_PROMPT_COUNT;
    const isLongByAge     = activeDays >= SESSION_FORCE_DAYS;
    const isWarnByAge     = activeDays >= SESSION_STALE_DAYS;

    if (!isWarnByPrompts && !isWarnByAge) return null;

    const isHandoff = isLongByPrompts || isLongByAge;
    const lines = [];
    lines.push('<!-- claudeye: session length warning -->');

    const ageStr = activeDays >= 1 ? ` · активна ${activeDays.toFixed(1)}d` : '';

    if (isHandoff) {
      lines.push(`## ⚠️ Длинная сессия: ${promptCount} промптов${ageStr}`);
      lines.push('');
      if (isLongByAge && !isLongByPrompts) {
        lines.push(`Эта сессия активна уже ${activeDays.toFixed(1)} дней. Контекст накапливает устаревшие инструкции из разных задач, каждый запрос тянет за собой мусор предыдущих дней. **Рекомендуется начать новую сессию.**`);
      } else {
        lines.push('Эта сессия очень длинная. Контекстное окно заполнено, каждый запрос тратит значительно больше токенов. **Рекомендуется начать новую сессию.**');
      }
      lines.push('');
      lines.push('Claudeye inject-hook автоматически подхватит контекст в новой сессии.');
    } else {
      lines.push(`## ℹ️ Сессия: ${promptCount} промптов${ageStr}`);
      lines.push('');
      if (isWarnByAge && !isWarnByPrompts) {
        lines.push(`Сессия держится уже больше суток. Если переключался между разными задачами — рассмотри свежую сессию для чистого контекста.`);
      } else {
        lines.push('Сессия становится длинной. Если задача позволяет — рассмотрите начало новой сессии для экономии квоты.');
      }
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
          lines.push(`- ${truncateSmart(o.summary, HANDOFF_BUDGET.recent)}`);
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
          lines.push(`- ${truncateSmart(e.summary, HANDOFF_BUDGET.errors)}`);
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

  // Skip internal claude --print calls from compress.js to prevent phantom
  // sessions. compress.js sets CLAUDEYE_INTERNAL=1 on its subprocess env.
  if (process.env.CLAUDEYE_INTERNAL === '1') process.exit(0);

  // Normalize worktree paths to parent project (#78)
  const rawProject = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const worktreeMatch = rawProject.match(/^(.+?)\/\.claude\/worktrees\/.+$/);
  const project = worktreeMatch ? worktreeMatch[1] : rawProject;

  // Global timeout: never block Claude Code for more than 5 seconds (#55)
  const TIMEOUT_MS = 5000;
  const timeout = setTimeout(() => {
    console.error('[mem:inject] timeout after ' + TIMEOUT_MS + 'ms — skipping injection');
    process.exit(0);
  }, TIMEOUT_MS);

  try {
    const { upsertSession, logHookError, getDb, saveEffortClassification, saveInjectionStat } = await import(srcDir + 'db.js');
    const { buildContextWithMetrics }  = await import(srcDir + 'search.js');

    upsertSession(sessionId, project);

    const { text: context, bytes, tokensEst, sections, budgetHit } =
      await buildContextWithMetrics(prompt, project);

    if (context) {
      process.stdout.write(context + '\n\n');
      // #90: record every injection so `claudeye injection-stats` can show the
      // RAG tax over time and trigger a health warning when p95 creeps up.
      try {
        saveInjectionStat({ sessionId, project, bytes, tokensEst, sections, budgetHit });
      } catch { /* never break inject-hook on stats failure */ }
    }

    // Effort classification (#63) — rule-based, zero-latency
    if (!process.env.CLAUDEYE_NO_EFFORT_ADVISOR) {
      try {
        const { classifyEffort } = await import(srcDir + 'effort.js');
        const classification = classifyEffort(prompt);
        if (classification && classification.confidence >= 0.7) {
          saveEffortClassification({
            sessionId,
            project,
            effort: classification.effort,
            confidence: classification.confidence,
            reason: classification.reason,
            promptWordCount: prompt.trim().split(/\s+/).length,
          });
        }
      } catch {
        // Non-critical — don't break the hook
      }
    }

    // Session length warning + handoff
    const handoff = buildSessionHandoff(getDb(), sessionId, project);
    if (handoff) {
      process.stdout.write(handoff + '\n\n');
    }

    // Behavioral advise injection (#87) — top-1 new high-confidence advise.
    // Shown once per advise; marks status='shown' so next session doesn't loop.
    try {
      const adv = getDb().prepare(`
        SELECT id, category, observation, why, proposal, code_draft, confidence
        FROM advises
        WHERE status = 'new'
        ORDER BY
          CASE confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
          created_at DESC
        LIMIT 1
      `).get();
      if (adv) {
        const lines = [];
        lines.push('<!-- claudeye: behavioral advise #' + adv.id + ' -->');
        lines.push(`## 💡 Claudeye совет (${adv.confidence}) — ${adv.category}`);
        lines.push('');
        lines.push(`**Наблюдение:** ${adv.observation}`);
        lines.push('');
        lines.push(`**Почему важно:** ${adv.why}`);
        lines.push('');
        lines.push(`**Предложение:** ${adv.proposal}`);
        if (adv.code_draft) {
          lines.push('');
          lines.push('```');
          lines.push(adv.code_draft.slice(0, 800));
          lines.push('```');
        }
        lines.push('');
        lines.push(`_\`claudeye advises accept ${adv.id}\` · \`claudeye advises dismiss ${adv.id} --reason "..."\`_`);
        process.stdout.write(lines.join('\n') + '\n\n');
        getDb().prepare(`UPDATE advises SET status='shown', shown_at=datetime('now') WHERE id=?`).run(adv.id);
      }
    } catch (e) {
      try { logHookError('inject-hook', 'advise-inject', e.message, project); } catch {}
    }
  } catch (err) {
    try { logHookError('inject-hook', 'general', err.message, project); } catch {}
    // Exit cleanly — don't block Claude Code on memory failure
  }

  clearTimeout(timeout);
  process.exit(0);
}

main();
