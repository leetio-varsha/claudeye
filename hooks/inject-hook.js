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

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const __dir = new URL('.', import.meta.url).pathname;
const srcDir = __dir + '../src/';

// ─── Once-per-day stderr nudges (#115) ─────────────────────────────────────
// File-based throttle so terminal nudges (e.g. "N actions await review") fire at
// most once per local day per kind, no matter how many prompts the user sends.
const _NUDGE_DIR = join(homedir(), '.claudeye', 'state');
function _nudgePath(kind) { return join(_NUDGE_DIR, `nudge-${kind}`); }
function _today() { return new Date().toLocaleDateString('en-CA'); } // local YYYY-MM-DD

function nudgedToday(kind) {
  try {
    const p = _nudgePath(kind);
    return existsSync(p) && readFileSync(p, 'utf8').trim() === _today();
  } catch { return false; }
}
function markNudged(kind) {
  try {
    if (!existsSync(_NUDGE_DIR)) mkdirSync(_NUDGE_DIR, { recursive: true });
    writeFileSync(_nudgePath(kind), _today());
  } catch { /* non-critical */ }
}

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
    const { upsertSession, isDegenerateProject, logHookError, getDb, saveEffortClassification, saveInjectionStat, saveObservation, isConsecutiveDuplicate } = await import(srcDir + 'db.js');
    const { buildContextWithMetrics }  = await import(srcDir + 'search.js');

    // #121: skip Claudeye's own Cowork scheduled/agent runs — they execute with no
    // CLAUDE_PROJECT_DIR, so `project` resolves to '/' or $TMPDIR. Registering a
    // session here creates an observation-less, never-closing junk row. Exit
    // before any DB write (parity with CLAUDEYE_INTERNAL guard above).
    if (isDegenerateProject(project)) { clearTimeout(timeout); process.exit(0); }

    upsertSession(sessionId, project);

    // ── Live prompt capture ────────────────────────────────────────────────
    // The `ClaudeCodeUserPrompt` observation used to be written ONLY by the
    // transcript backfill script (scripts/backfill-claude-code.mjs), so the
    // metric silently froze whenever the periodic import stopped running — it
    // sat at 2,631 for 8 days (last 2026-07-08) while live tool obs (Bash/Read/
    // Edit) streamed normally. The analyzer mistook this import-lag artifact for
    // a dead UserPromptSubmit hook and prescribed an irrelevant ABI-pin fix.
    // Fix: capture the prompt in real time here, the same way PostToolUse
    // captures tool obs — no import dependency, no lag. Backfill is now only an
    // outage-recovery tool. Dedup guards against Claude Code re-submitting the
    // same prompt (resume/retry). tags 'live' distinguish these from 'backfill'.
    try {
      const promptText = prompt.trim();
      if (promptText && !isConsecutiveDuplicate({ sessionId, tool: 'ClaudeCodeUserPrompt', rawInput: promptText })) {
        const wc = promptText.split(/\s+/).length;
        saveObservation({
          sessionId, project,
          tool: 'ClaudeCodeUserPrompt',
          summary: promptText.slice(0, 500),
          rawInput: promptText,
          tags: ['claude-code', 'user', 'live'],
          importance: wc <= 5 ? 0.2 : 0.55,
        });
      }
    } catch (e) {
      try { logHookError('inject-hook', 'prompt-capture', e.message, project); } catch {}
    }

    const { text: context, bytes, tokensEst, sections, budgetHit } =
      await buildContextWithMetrics(prompt, project);

    if (context) {
      process.stdout.write(context + '\n\n');
      // #90: record every injection so `claudeye injection-stats` can show the
      // RAG tax over time and trigger a health warning when p95 creeps up.
      try {
        saveInjectionStat({ sessionId, project, bytes, tokensEst, sections, budgetHit });
      } catch { /* never break inject-hook on stats failure */ }

      // Stderr visibility: brief one-liner so user sees Claudeye is active.
      // stderr goes to terminal (not into the Claude prompt), so this is safe.
      try {
        const kb = (bytes / 1024).toFixed(1);
        const parts = (sections || [])
          .filter(s => s.count > 0)
          .map(s => `${s.name}:${s.count}`);
        const label = parts.length ? ` (${parts.join(', ')})` : '';
        process.stderr.write(`📌 Claudeye: ${kb}KB injected${label}\n`);
      } catch { /* non-critical */ }
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

    // Proactive workflow suggestions (#28, slice 6/7) — «при старте сессии».
    // Показываем РОВНО на первом промпте новой сессии (prompt_count === 0 сразу
    // после первого upsertSession), чтобы не шуметь на каждом промпте и не
    // дублировать handoff (длинная сессия → prompt_count > 0 → сюда не зайдём).
    try {
      const db = getDb();
      const s = db.prepare('SELECT prompt_count FROM sessions WHERE id = ?').get(sessionId);
      if (s && s.prompt_count === 0) {
        const { getProactiveSuggestions } = await import(srcDir + 'workflow.js');
        const { hints } = getProactiveSuggestions({ project, max: 3, db });
        if (hints.length) {
          const lines = ['<!-- claudeye: proactive workflow suggestions (#28) -->'];
          lines.push(`## 🧭 Claudeye — по опыту работы над ${project.split('/').pop()}`);
          lines.push('');
          for (const h of hints) lines.push(`- ${h}`);
          lines.push('');
          lines.push('<!-- end claudeye proactive suggestions -->');
          process.stdout.write(lines.join('\n') + '\n\n');
          process.stderr.write(`🧭 Claudeye: ${hints.length} workflow-подсказ${hints.length === 1 ? 'ка' : 'ки'} в начале промпта\n`);
        }
      }
    } catch (e) {
      try { logHookError('inject-hook', 'proactive-suggest', e.message, project); } catch {}
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
        // Also notify via stderr so user sees it in terminal
        process.stderr.write(`💡 Claudeye совет: ${adv.category} (${adv.confidence}) — см. начало промпта\n`);
      }
    } catch (e) {
      try { logHookError('inject-hook', 'advise-inject', e.message, project); } catch {}
    }

    // Agent feedback-loop review nudge (#115) — stderr only, once per day.
    // Mirrors the inject-visibility fix (65f278b): a backlog the user never sees
    // doesn't exist. We do a tiny direct query here (no agent.js import) to keep
    // the hook lean, and throttle via a date marker so we nudge at most daily.
    try {
      const REVIEW_PENDING_WARN = 50;
      const db = getDb();
      const pending = db.prepare(
        `SELECT COUNT(*) AS n FROM agent_actions WHERE feedback IS NULL`
      ).get().n ?? 0;

      if (pending >= REVIEW_PENDING_WARN) {
        const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
        const reviewedRecent = db.prepare(
          `SELECT COUNT(*) AS n FROM agent_actions
           WHERE feedback IN ('accepted','rejected') AND feedback_at >= ?`
        ).get(cutoff).n ?? 0;

        if (reviewedRecent === 0 && !nudgedToday('review')) {
          process.stderr.write(`🤖 Claudeye: ${pending} agent-действий ждут review — \`claudeye agent review\`\n`);
          markNudged('review');
        }
      }
    } catch { /* non-critical — never break the hook on the nudge */ }
  } catch (err) {
    try { logHookError('inject-hook', 'general', err.message, project); } catch {}
    // Exit cleanly — don't block Claude Code on memory failure
  }

  clearTimeout(timeout);
  process.exit(0);
}

main();
