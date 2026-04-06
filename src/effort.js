/**
 * src/effort.js — Rule-based effort classification
 *
 * Classifies user prompts by optimal effort level (low/medium/high).
 * Zero-latency: no API calls, pure pattern matching.
 *
 * NOTE: \b word boundary doesn't work with Cyrillic in JS regex.
 * We use (?:^|[\s,.!?;:()]) and (?:$|[\s,.!?;:()]) or simply
 * non-anchored patterns since false positives are low-cost here.
 *
 * @see https://github.com/leetio-varsha/claudeye/issues/63
 */

// ─── Patterns ────────────────────────────────────────────────────────────────
// No \b — use unanchored patterns (Cyrillic-safe)

const LOW_PATTERNS = [
  // Typos, formatting, cosmetic
  /typo|опечатк/i,
  /\brename\b|переименуй/i,
  /\bformat|форматирован|indent|отступ/i,
  /\blint\b|\bprettier\b|\beslint\b/i,
  // Simple file ops
  /удали\s+(файл|строк)|delete\s+(file|line)|remove\s+unused/i,
  // Import fixes
  /добавь\s+import|fix\s+import|missing\s+import/i,
  // Comments
  /добавь\s+коммент|add\s+comment|update\s+comment/i,
  // Version bumps
  /bump\s+version|обнови\s+версию/i,
  // Simple renames / moves
  /move\s+file|перемести\s+файл/i,
];

const HIGH_PATTERNS = [
  // Debugging
  /\bdebug|дебаг|отлад/i,
  /почему.{0,30}(падает|не работает|ломается|ошибк|fail|crash)/i,
  /why.{0,20}(fail|crash|break|error|not work)/i,
  // Architecture
  /architect|архитектур/i,
  /design\s+pattern|system\s+design/i,
  // Performance
  /\bperformance|перформанс|оптимиз|bottleneck|узкое\s+место/i,
  /\blatency\b|\bslow\b|медленн/i,
  // Security
  /security|безопасност|vulnerab|уязвимост/i,
  /аутентификац|\binjection\b|\bxss\b|\bcsrf\b/i,
  // Complex analysis
  /проанализируй|\banalyze\b|разбер(и|ись)|investigate|расследуй/i,
  // Migration / major refactor
  /\bmigrat|миграци|major\s+refactor|масштабн|переписать|\brewrite\b/i,
  // Stack traces / error logs present
  /stack\s*trace|traceback/i,
  /Error:.*\n\s+at\s+/,
  /TypeError|ReferenceError|SyntaxError/,
  // Multi-file / complex scope
  /across\s+(all|multiple|the)\s+files|во\s+всех\s+файлах|глобальн/i,
];

const MEDIUM_PATTERNS = [
  // CRUD / basic features
  /добавь\s+(поле|колонк|столб|endpoint|маршрут|роут)/i,
  /add\s+(field|column|endpoint|route)/i,
  // Simple features
  /создай\s+(компонент|функци|класс|файл)/i,
  /create\s+(component|function|class|file)/i,
  // Tests
  /напиши\s+тест|write\s+test|add\s+test|добавь\s+тест/i,
  // Config changes
  /\bconfig\b|конфиг|настрой|\bsetup\b/i,
  // Basic refactoring
  /\brefactor|рефактор|extract\s+(function|method)|вынеси\s+в/i,
  // Update / modify
  /обнови|измени|\bmodify\b|поменяй/i,
];

// ─── Classification ──────────────────────────────────────────────────────────

/**
 * Classify a user prompt by optimal effort level.
 *
 * @param {string} message — raw user prompt
 * @returns {{ effort: 'low'|'medium'|'high', confidence: number, reason: string } | null}
 *   Returns null if message is too short to classify (< 10 words).
 */
export function classifyEffort(message) {
  if (!message || typeof message !== 'string') return null;

  const words = message.trim().split(/\s+/);
  if (words.length < 10) return null; // Too little context

  const text = message.trim();

  // Score each level
  const lowScore  = countMatches(text, LOW_PATTERNS);
  const highScore = countMatches(text, HIGH_PATTERNS);
  const medScore  = countMatches(text, MEDIUM_PATTERNS);

  // Stack trace / error log presence is a strong high signal
  const hasStackTrace = /\n\s+at\s+/.test(text) || /Traceback|Error:.*\n/.test(text);
  const effectiveHighScore = highScore + (hasStackTrace ? 2 : 0);

  // Length heuristic: very long prompts with lots of context → likely complex
  const lengthBonus = words.length > 100 ? 1 : 0;

  const scores = {
    low:    lowScore,
    medium: medScore + lengthBonus,
    high:   effectiveHighScore + lengthBonus,
  };

  // Find winner
  const entries = Object.entries(scores);
  entries.sort((a, b) => b[1] - a[1]);

  const [topLevel, topScore] = entries[0];
  const [, secondScore] = entries[1];

  // No patterns matched → default medium, low confidence
  if (topScore === 0) {
    return {
      effort: 'medium',
      confidence: 0.3,
      reason: 'no clear patterns detected, defaulting to medium',
    };
  }

  // Calculate confidence based on margin between top and second
  const margin = topScore - secondScore;
  let confidence;
  if (margin >= 2) {
    confidence = 0.9;
  } else if (margin === 1) {
    confidence = 0.7;
  } else {
    // Tie — pick higher effort as safer bet
    const tiedLevel = effectiveHighScore >= medScore ? 'high' : (medScore >= lowScore ? 'medium' : 'low');
    return {
      effort: tiedLevel,
      confidence: 0.5,
      reason: `tie between levels (scores: low=${scores.low}, med=${scores.medium}, high=${scores.high})`,
    };
  }

  // Build reason from matched patterns
  const reason = buildReason(text, topLevel, scores);

  return {
    effort: topLevel,
    confidence,
    reason,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function countMatches(text, patterns) {
  let count = 0;
  for (const p of patterns) {
    if (p.test(text)) count++;
  }
  return count;
}

function buildReason(text, level, scores) {
  const parts = [`scores: low=${scores.low}, med=${scores.medium}, high=${scores.high}`];

  if (level === 'low') {
    if (/typo|опечатк/i.test(text)) parts.push('typo fix');
    if (/rename|переименуй/i.test(text)) parts.push('rename');
    if (/format|lint/i.test(text)) parts.push('formatting');
  } else if (level === 'high') {
    if (/debug|дебаг|почему/i.test(text)) parts.push('debugging');
    if (/architect|архитектур/i.test(text)) parts.push('architecture');
    if (/performance|оптимиз/i.test(text)) parts.push('performance');
    if (/security|безопасност/i.test(text)) parts.push('security');
    if (/stack\s*trace|Error:/i.test(text)) parts.push('error analysis');
  } else {
    if (/добавь|create|add/i.test(text)) parts.push('feature addition');
    if (/refactor|рефактор/i.test(text)) parts.push('refactoring');
    if (/test|тест/i.test(text)) parts.push('testing');
  }

  return parts.join('; ');
}
