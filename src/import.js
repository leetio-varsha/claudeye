/**
 * src/import.js — Git import for Claudeye
 * Reads local git log, AI-compresses rich commits,
 * generates embeddings, stores in mem.db
 */
import { execSync } from 'child_process';
import { getDb, saveObservation, upsertSession, closeSession, saveEmbedding } from './db.js';
import { compressObservation as compress } from './compress.js';
import { embed } from './embeddings.js';

function estimateImportance(msg) {
  const m = msg.toLowerCase();
  if (/^(breaking|revert)/.test(m)) return 0.9;
  if (/^fix\b|hotfix\b|bug\b|critical/.test(m)) return 0.75;
  if (/^feat\b|add\b/.test(m)) return 0.65;
  if (/^refactor\b|perf\b/.test(m)) return 0.55;
  if (/^test\b|^ci\b|^cd\b/.test(m)) return 0.4;
  if (/^docs\b|^chore\b|^style\b/.test(m)) return 0.3;
  if (/merge branch\b/.test(m)) return 0.15;
  return 0.5;
}

export async function importGit(repoPath, opts = {}) {
  const { since = null, limit = null, skipAi = false } = opts;
  const db = getDb();

  // Ensure import_sources table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS import_sources (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      path   TEXT NOT NULL,
      last_hash TEXT,
      imported_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const existing = db.prepare(
    'SELECT last_hash FROM import_sources WHERE source = ? AND path = ?'
  ).get('git', repoPath);

  // Build git log command
  let cmd = `git -C "${repoPath}" log --format="%H%x00%ai%x00%an%x00%s"`;
  if (since) cmd += ` --since="${since}"`;
  if (existing?.last_hash) cmd += ` ${existing.last_hash}..HEAD`;
  if (limit) cmd += ` -n ${limit}`;

  let output;
  try {
    output = execSync(cmd, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 }).trim();
  } catch (e) {
    console.error(`Failed to read git log from ${repoPath}:`, e.message);
    return { imported: 0, skipped: 0, error: e.message };
  }

  if (!output) return { imported: 0, skipped: 0, error: 'No new commits' };

  const lines = output.split('\n').filter(Boolean);
  const sessionId = `import-git-${Date.now()}`;
  upsertSession(sessionId, repoPath);

  let imported = 0;
  let skipped = 0;
  let firstHash = null;

  for (const line of lines) {
    const parts = line.split('\x00');
    const hash = parts[0];
    const date = parts[1];
    const author = parts[2];
    const msg = parts.slice(3).join('\x00');
    if (!hash) continue;
    if (!firstHash) firstHash = hash;

    const importance = estimateImportance(msg);

    // Skip noise
    if (importance < 0.2) {
      skipped++;
      continue;
    }

    let summary = `[${author}] ${msg}`;
    let tags = ['git', 'import'];

    // AI compression for rich commits (importance >= 0.5)
    if (!skipAi && importance >= 0.5) {
      try {
        let diffStat = '';
        try {
          diffStat = execSync(
            `git -C "${repoPath}" show --stat --no-patch --format="" ${hash}`,
            { encoding: 'utf8' }
          ).trim().slice(0, 1000);
        } catch {}

        const compressed = await compress({ tool: 'git-commit', input: `${msg}\n\n${diffStat}`, output: '', project: repoPath });
        if (compressed) {
          summary = compressed.summary || summary;
          tags = [...tags, ...(compressed.tags || [])];
        }
      } catch {
        // AI failed, use raw message
      }
    }

    // Save observation
    const obsId = saveObservation({
      sessionId,
      project: repoPath,
      tool: 'git-commit',
      summary,
      rawInput: msg,
      rawOutput: hash,
      tags,
      importance,
    });

    // Generate embedding
    try {
      const vec = await embed(summary);
      if (vec) saveEmbedding(obsId, vec);
    } catch {}

    imported++;
    if (imported % 50 === 0) {
      process.stderr.write(`\r[mem:import] ${imported}/${lines.length} commits processed...`);
    }
  }

  // Track import source
  if (firstHash) {
    if (existing) {
      db.prepare("UPDATE import_sources SET last_hash = ?, imported_at = datetime('now') WHERE source = ? AND path = ?").run(firstHash, 'git', repoPath);
    } else {
      db.prepare('INSERT INTO import_sources (source, path, last_hash) VALUES (?, ?, ?)').run('git', repoPath, firstHash);
    }
  }

  // Close the import session so it doesn't show up as orphaned (#60)
  closeSession(sessionId, `Git import: ${imported} commits from ${repoPath.split('/').pop()}`);

  return { imported, skipped, total: lines.length };
}
