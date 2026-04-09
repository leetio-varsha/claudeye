/**
 * scripts/generate-claude-md.js — Auto-generate CLAUDE.md hints from mem.db (#57)
 *
 * Queries high-importance observations + decisions for a project,
 * uses Claude CLI to suggest CLAUDE.md additions.
 */

import { spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { getDb } from '../src/db.js';

const SYSTEM_PROMPT = `You are a CLAUDE.md generator. Given observations from a developer's Claude Code sessions, generate useful additions for the project's CLAUDE.md file.

CLAUDE.md is a special file that Claude Code reads at the start of every session. It should contain:
- Key architectural decisions and patterns used in the project
- Common pitfalls and their solutions
- Project-specific conventions and workflows
- Important configuration details
- Recurring issues and how to handle them

Rules:
- Output ONLY the markdown content to add. No explanations, no preamble.
- Use concise bullet points grouped by topic.
- Reference specific files, commands, or patterns from the observations.
- Skip anything that's obvious from package.json or README.
- Skip generic advice — only project-specific insights.
- If existing CLAUDE.md already covers a topic, don't repeat it.
- Keep output under 40 lines.`;

/**
 * Build context from high-importance observations for a project.
 */
function buildProjectContext(project, { days = 30, limit = 30 } = {}) {
  const db = getDb();

  // High-importance observations
  const observations = db.prepare(`
    SELECT summary, tool, tags, importance, created_at
    FROM observations
    WHERE project = ?
      AND importance >= 0.7
      AND tool != 'git-commit'
      AND created_at >= date('now', '-' || ? || ' days')
    ORDER BY importance DESC, created_at DESC
    LIMIT ?
  `).all(project, days, limit);

  // Decision memory
  const decisions = db.prepare(`
    SELECT summary, decision_rationale, created_at
    FROM observations
    WHERE project = ?
      AND decision_rationale IS NOT NULL
    ORDER BY importance DESC, created_at DESC
    LIMIT 10
  `).all(project);

  // Session summaries
  const sessions = db.prepare(`
    SELECT summary, friction_score, prompt_count
    FROM sessions
    WHERE project = ?
      AND summary IS NOT NULL
      AND summary != ''
      AND id NOT LIKE 'import-git-%'
    ORDER BY started_at DESC
    LIMIT 10
  `).all(project);

  // Frequent error patterns
  const errors = db.prepare(`
    SELECT summary, COUNT(*) as occurrences
    FROM observations
    WHERE project = ?
      AND importance >= 0.8
      AND created_at >= date('now', '-' || ? || ' days')
      AND tool != 'git-commit'
    GROUP BY summary
    HAVING occurrences >= 2
    ORDER BY occurrences DESC
    LIMIT 10
  `).all(project, days);

  return { observations, decisions, sessions, errors };
}

/**
 * Generate CLAUDE.md suggestions using Claude CLI.
 *
 * @param {string} project — absolute project path
 * @param {object} opts
 * @param {number} opts.days — lookback period
 * @param {boolean} opts.dryRun — if true, only return suggestions without writing
 * @param {boolean} opts.append — if true, append to existing CLAUDE.md
 * @returns {string|null} — generated content or null
 */
export async function generateClaudeMd(project, { days = 30, dryRun = false, append = true } = {}) {
  const context = buildProjectContext(project, { days });

  if (!context.observations.length && !context.decisions.length) {
    return null; // not enough data
  }

  // Read existing CLAUDE.md if present
  const claudeMdPath = join(project, 'CLAUDE.md');
  let existingContent = '';
  if (existsSync(claudeMdPath)) {
    existingContent = readFileSync(claudeMdPath, 'utf8');
  }

  const userPrompt = `Generate CLAUDE.md additions for this project.

PROJECT: ${project.split('/').pop()}

${existingContent ? `EXISTING CLAUDE.md (do NOT repeat these topics):\n${existingContent.slice(0, 2000)}\n` : 'No existing CLAUDE.md.'}

HIGH-IMPORTANCE OBSERVATIONS (${context.observations.length}):
${context.observations.map(o => `- [${o.tool}] (imp=${o.importance}) ${o.summary}`).join('\n')}

${context.decisions.length ? `DECISIONS:\n${context.decisions.map(d => `- ${d.decision_rationale || d.summary}`).join('\n')}\n` : ''}
${context.errors.length ? `RECURRING PATTERNS (×count):\n${context.errors.map(e => `- (×${e.occurrences}) ${e.summary}`).join('\n')}\n` : ''}
${context.sessions.length ? `RECENT SESSIONS:\n${context.sessions.map(s => `- ${s.summary} (friction=${s.friction_score}, prompts=${s.prompt_count})`).join('\n')}` : ''}`;

  const fullPrompt = `${SYSTEM_PROMPT}\n\n${userPrompt}`;

  const result = spawnSync('claude', ['--print', '-'], {
    input: fullPrompt,
    encoding: 'utf8',
    timeout: 120_000,
  });

  if (result.status !== 0) {
    throw new Error(`Claude CLI failed: ${result.stderr}`);
  }

  const generated = result.stdout.trim();
  if (!generated) return null;

  if (dryRun) {
    return generated;
  }

  // Write or append
  if (append && existingContent) {
    const separator = '\n\n<!-- Auto-generated by claudeye generate-claude-md -->\n\n';
    // Remove previous auto-generated section if exists
    const marker = '<!-- Auto-generated by claudeye generate-claude-md -->';
    const markerIdx = existingContent.indexOf(marker);
    if (markerIdx !== -1) {
      const cleaned = existingContent.slice(0, markerIdx).trimEnd();
      writeFileSync(claudeMdPath, cleaned + separator + generated + '\n');
    } else {
      appendFileSync(claudeMdPath, separator + generated + '\n');
    }
  } else {
    writeFileSync(claudeMdPath, generated + '\n');
  }

  return generated;
}

/**
 * Get list of all projects with enough data for generation.
 */
export function getEligibleProjects({ days = 30, minObs = 10 } = {}) {
  const db = getDb();
  return db.prepare(`
    SELECT project, COUNT(*) as obs_count,
           SUM(CASE WHEN importance >= 0.7 THEN 1 ELSE 0 END) as high_imp_count
    FROM observations
    WHERE created_at >= date('now', '-' || ? || ' days')
      AND tool != 'git-commit'
    GROUP BY project
    HAVING high_imp_count >= ?
    ORDER BY high_imp_count DESC
  `).all(days, minObs);
}
