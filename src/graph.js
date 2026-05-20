/**
 * src/graph.js — Knowledge Graph: entities + relations (#26)
 *
 * Extracts named entities from observations and builds a relation graph:
 *   file → project (belongs_to)
 *   file → bug     (caused_by / fixed_by)
 *   tool → file    (authored_by)
 *   decision → file (decided_in)
 *   file ↔ file    (related_to, from co-mention in same observation)
 *
 * Entity types: file | project | tool | bug | decision | person
 * Relation types: caused_by | fixed_by | depends_on | related_to |
 *                 decided_in | authored_by | belongs_to | touched_in
 *
 * All extraction is regex-based (no AI call) — fast enough for hook pipelines.
 */

import { getDb } from './db.js';

// ─── Entity extraction ────────────────────────────────────────────────────

const FILE_RE = /(?:^|[\s"'`(,])(\/?(?:[\w.-]+\/)+[\w.-]+\.(?:js|ts|mjs|cjs|jsx|tsx|py|go|rb|rs|sql|md|json|yaml|yml|sh|toml|env|css|html|vue|svelte))\b/g;
const TOOL_WRITE_RE = /\b(Edit|Write|Bash|Read|Glob|Grep)\b/g;

/**
 * Extract file entities from observation summary + raw_input.
 * Returns array of unique relative-ish file paths.
 */
export function extractFileEntities(summary = '', rawInput = '') {
  const text = `${summary}\n${rawInput || ''}`;
  const found = new Set();
  let m;
  FILE_RE.lastIndex = 0;
  while ((m = FILE_RE.exec(text)) !== null) {
    const p = m[1].trim();
    // Skip node_modules and very short fragments
    if (p.includes('node_modules')) continue;
    if (p.split('/').pop().length < 3) continue;
    found.add(p);
  }
  return [...found];
}

/**
 * Determine relation type between a file and the observation based on tags.
 * Returns the dominant relation string.
 */
export function fileRelationType(tags = []) {
  if (tags.includes('bugfix') || tags.includes('fix')) return 'fixed_by';
  if (tags.includes('error') || tags.includes('bug'))  return 'caused_by';
  if (tags.includes('decision'))                        return 'decided_in';
  return 'touched_in';
}

// ─── DB helpers ──────────────────────────────────────────────────────────

/**
 * Upsert an entity — increments mention_count and updates last_seen on conflict.
 * Returns the entity's id.
 */
export function upsertEntity(db, { project, type, name, metadata = {} }) {
  const existing = db.prepare(`
    SELECT id FROM entities WHERE project = ? AND type = ? AND name = ?
  `).get(project, type, name);

  if (existing) {
    db.prepare(`
      UPDATE entities
      SET mention_count = mention_count + 1,
          last_seen     = datetime('now')
      WHERE id = ?
    `).run(existing.id);
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO entities (project, type, name, metadata)
    VALUES (?, ?, ?, ?)
  `).run(project, type, name, JSON.stringify(metadata));
  return result.lastInsertRowid;
}

/**
 * Upsert a relation between two entities.
 * On conflict (same source/target/type), bumps weight by 1.
 */
export function upsertRelation(db, { sourceId, targetId, relationType, obsId = null }) {
  const existing = db.prepare(`
    SELECT id, weight FROM relations
    WHERE source_id = ? AND target_id = ? AND relation_type = ?
  `).get(sourceId, targetId, relationType);

  if (existing) {
    db.prepare(`
      UPDATE relations SET weight = weight + 1 WHERE id = ?
    `).run(existing.id);
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO relations (source_id, target_id, relation_type, obs_id)
    VALUES (?, ?, ?, ?)
  `).run(sourceId, targetId, relationType, obsId ?? null);
  return result.lastInsertRowid;
}

// ─── Main pipeline ────────────────────────────────────────────────────────

/**
 * Process one observation: extract entities and build relations.
 * Called after an observation is stored in the DB.
 *
 * @param {object} obs  - observation row from DB
 *   { id, project, tool, summary, tags (JSON string), raw_input, importance }
 */
export function addObservationToGraph(obs) {
  if (!obs || !obs.project || !obs.summary) return;

  const db = getDb();
  const tags = (() => {
    try { return JSON.parse(obs.tags || '[]'); } catch { return []; }
  })();

  // Skip noise
  if (obs.importance !== undefined && obs.importance < 0.2) return;

  const projectName = obs.project.split('/').pop() || obs.project;

  // 1. Project entity
  const projectId = upsertEntity(db, {
    project: obs.project,
    type:    'project',
    name:    projectName,
  });

  // 2. Tool entity
  const toolId = upsertEntity(db, {
    project: obs.project,
    type:    'tool',
    name:    obs.tool,
  });
  // tool belongs_to project
  upsertRelation(db, { sourceId: toolId, targetId: projectId, relationType: 'belongs_to', obsId: obs.id });

  // 3. File entities extracted from summary + raw_input
  const files = extractFileEntities(obs.summary, obs.raw_input);
  const relType = fileRelationType(tags);
  const fileIds = [];

  for (const filePath of files) {
    const fileId = upsertEntity(db, {
      project:  obs.project,
      type:     'file',
      name:     filePath,
    });
    fileIds.push(fileId);

    // file → project
    upsertRelation(db, { sourceId: fileId, targetId: projectId, relationType: 'belongs_to', obsId: obs.id });
    // tool → file
    upsertRelation(db, { sourceId: toolId, targetId: fileId, relationType: 'authored_by', obsId: obs.id });
    // file ← observation relation (semantic, e.g. touched_in / fixed_by / caused_by)
    upsertRelation(db, { sourceId: fileId, targetId: projectId, relationType: relType, obsId: obs.id });
  }

  // 4. Co-mention relations between files in same observation
  for (let i = 0; i < fileIds.length; i++) {
    for (let j = i + 1; j < fileIds.length; j++) {
      upsertRelation(db, { sourceId: fileIds[i], targetId: fileIds[j], relationType: 'related_to', obsId: obs.id });
    }
  }

  // 5. Decision entity if tagged
  if (tags.includes('decision') && obs.decision_rationale) {
    const decisionName = obs.decision_rationale.slice(0, 120);
    const decisionId = upsertEntity(db, {
      project:  obs.project,
      type:     'decision',
      name:     decisionName,
      metadata: { obs_id: obs.id },
    });
    upsertRelation(db, { sourceId: decisionId, targetId: projectId, relationType: 'decided_in', obsId: obs.id });
    for (const fid of fileIds) {
      upsertRelation(db, { sourceId: decisionId, targetId: fid, relationType: 'decided_in', obsId: obs.id });
    }
  }
}

// ─── Query API ────────────────────────────────────────────────────────────

/**
 * Get all entities + their relations for a project.
 * Returns { entities: [...], relations: [...] }
 */
export function getProjectGraph(project) {
  const db = getDb();

  const entities = db.prepare(`
    SELECT id, type, name, mention_count, first_seen, last_seen
    FROM entities
    WHERE project = ?
    ORDER BY mention_count DESC, type, name
  `).all(project);

  const relations = db.prepare(`
    SELECT r.id, r.source_id, r.target_id, r.relation_type, r.weight,
           es.name AS source_name, es.type AS source_type,
           et.name AS target_name, et.type AS target_type
    FROM relations r
    JOIN entities es ON r.source_id = es.id
    JOIN entities et ON r.target_id = et.id
    WHERE es.project = ?
    ORDER BY r.weight DESC
  `).all(project);

  return { entities, relations };
}

/**
 * Get all relations for a specific entity by name (across all projects).
 * Returns { entity, relations: [...] }
 */
export function getEntityRelations(entityName, project = null) {
  const db = getDb();

  const where = project
    ? `WHERE e.name = ? AND e.project = ?`
    : `WHERE e.name = ?`;
  const params = project ? [entityName, project] : [entityName];

  const entity = db.prepare(`
    SELECT id, project, type, name, mention_count, first_seen, last_seen
    FROM entities e
    ${where}
    ORDER BY mention_count DESC
    LIMIT 1
  `).get(...params);

  if (!entity) return { entity: null, relations: [] };

  const relations = db.prepare(`
    SELECT r.relation_type, r.weight,
           CASE WHEN r.source_id = ? THEN 'outgoing' ELSE 'incoming' END AS direction,
           CASE WHEN r.source_id = ? THEN et.name ELSE es.name END AS other_name,
           CASE WHEN r.source_id = ? THEN et.type ELSE es.type END AS other_type
    FROM relations r
    JOIN entities es ON r.source_id = es.id
    JOIN entities et ON r.target_id = et.id
    WHERE r.source_id = ? OR r.target_id = ?
    ORDER BY r.weight DESC
    LIMIT 50
  `).all(entity.id, entity.id, entity.id, entity.id, entity.id);

  return { entity, relations };
}

/**
 * Rebuild the Knowledge Graph from existing observations.
 * Useful after first install or after clearing the graph tables.
 *
 * @param {object} opts
 * @param {string} [opts.project]   - scope to one project (null = all)
 * @param {number} [opts.limit]     - max observations to process (safety cap)
 * @param {function} [opts.onProgress] - called with (processed, total)
 */
export function rebuildGraph({ project = null, limit = 50_000, onProgress } = {}) {
  const db = getDb();

  // Clear existing graph for the scope
  if (project) {
    const entityIds = db.prepare(`SELECT id FROM entities WHERE project = ?`).all(project).map(r => r.id);
    if (entityIds.length) {
      db.prepare(`DELETE FROM relations WHERE source_id IN (${entityIds.map(() => '?').join(',')}) OR target_id IN (${entityIds.map(() => '?').join(',')})`).run(...entityIds, ...entityIds);
      db.prepare(`DELETE FROM entities WHERE project = ?`).run(project);
    }
  } else {
    db.exec(`DELETE FROM relations; DELETE FROM entities;`);
  }

  const whereClause = project ? `WHERE project = ? AND importance >= 0.2` : `WHERE importance >= 0.2`;
  const params = project ? [project, limit] : [limit];

  const observations = db.prepare(`
    SELECT id, project, tool, summary, tags, raw_input, importance, decision_rationale
    FROM observations
    ${whereClause}
    ORDER BY created_at ASC
    LIMIT ?
  `).all(...params);

  const total = observations.length;
  let processed = 0;

  for (const obs of observations) {
    addObservationToGraph(obs);
    processed++;
    if (onProgress && processed % 500 === 0) onProgress(processed, total);
  }

  if (onProgress) onProgress(total, total);
  return { processed, total };
}

/**
 * Top entities by mention count for a project.
 */
export function getTopEntities(project, { type = null, limit = 20 } = {}) {
  const db = getDb();
  const typeClause = type ? `AND type = ?` : '';
  const params = type ? [project, type, limit] : [project, limit];
  return db.prepare(`
    SELECT id, type, name, mention_count, first_seen, last_seen
    FROM entities
    WHERE project = ? ${typeClause}
    ORDER BY mention_count DESC
    LIMIT ?
  `).all(...params);
}
