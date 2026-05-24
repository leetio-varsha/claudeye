/**
 * src/project-registry.js — Project Registry (#27)
 *
 * Maintains ~/.claudeye/projects.json — a lightweight index of all projects
 * that have used Claudeye. Enables Personal AI OS features:
 *   - Auto-discovery on first hook run in a new project
 *   - `claudeye projects` CLI command
 *   - Cross-project search scoping
 *
 * Format: { version: 1, projects: [{ path, shortName, firstSeen, lastSeen }] }
 *
 * All writes are atomic (write-to-tmp + rename) to avoid corruption.
 * registerProject() is safe to call from hot hooks — it's a no-op if the
 * project is already up-to-date within the same UTC day.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { homedir, tmpdir } from 'os';

const REGISTRY_VERSION = 1;

// Computed at call-time so tests can override HOME via process.env.HOME.
function claudeyeDir() { return join(homedir(), '.claudeye'); }
function registryPath() { return join(claudeyeDir(), 'projects.json'); }

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * @typedef {{
 *   path:      string,
 *   shortName: string,
 *   firstSeen: string,
 *   lastSeen:  string,
 * }} ProjectEntry
 *
 * @typedef {{ version: number, projects: ProjectEntry[] }} Registry
 */

// ─── I/O ──────────────────────────────────────────────────────────────────────

/**
 * Load registry from disk. Returns empty registry if file is missing or corrupt.
 * @returns {Registry}
 */
export function loadRegistry() {
  try {
    const rp = registryPath();
    if (!existsSync(rp)) return _empty();
    const raw = JSON.parse(readFileSync(rp, 'utf8'));
    if (!Array.isArray(raw.projects)) return _empty();
    return { version: REGISTRY_VERSION, projects: raw.projects };
  } catch {
    return _empty();
  }
}

/**
 * Persist registry to disk using atomic write (tmp + rename).
 * @param {Registry} registry
 */
function saveRegistry(registry) {
  const dir = claudeyeDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = join(tmpdir(), `claudeye-registry-${process.pid}.json`);
  writeFileSync(tmp, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  renameSync(tmp, registryPath());
}

function _empty() {
  return { version: REGISTRY_VERSION, projects: [] };
}

// ─── Core API ─────────────────────────────────────────────────────────────────

/**
 * Register a project in the registry. Safe to call on every hook invocation.
 * - If project is new → adds entry with firstSeen = lastSeen = now
 * - If project exists and lastSeen is today → no-op (avoid write on every hook)
 * - If project exists and lastSeen is stale → updates lastSeen only
 *
 * @param {string} projectPath  Absolute project path (already worktree-normalised)
 * @returns {boolean} true if the registry was modified (new project or stale lastSeen)
 */
export function registerProject(projectPath) {
  if (!projectPath) return false;

  const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  try {
    const registry = loadRegistry();
    const existing = registry.projects.find(p => p.path === projectPath);

    if (existing) {
      // Already known — only write if lastSeen is stale (different day)
      if (existing.lastSeen.slice(0, 10) === todayStr) return false;
      existing.lastSeen = new Date().toISOString();
      saveRegistry(registry);
      return true;
    }

    // New project — prepend so most-recent is first
    const now = new Date().toISOString();
    registry.projects.unshift({
      path:      projectPath,
      shortName: basename(projectPath),
      firstSeen: now,
      lastSeen:  now,
    });
    saveRegistry(registry);
    return true;
  } catch {
    // Non-critical — never crash the caller
    return false;
  }
}

/**
 * Return all registered projects sorted by lastSeen descending.
 * @returns {ProjectEntry[]}
 */
export function listProjects() {
  const { projects } = loadRegistry();
  return [...projects].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

/**
 * Return the number of distinct registered projects.
 * @returns {number}
 */
export function projectCount() {
  return loadRegistry().projects.length;
}

/**
 * Remove a project from the registry by exact path.
 * @param {string} projectPath
 * @returns {boolean} true if the project was found and removed
 */
export function unregisterProject(projectPath) {
  if (!projectPath) return false;
  try {
    const registry = loadRegistry();
    const before = registry.projects.length;
    registry.projects = registry.projects.filter(p => p.path !== projectPath);
    if (registry.projects.length === before) return false;
    saveRegistry(registry);
    return true;
  } catch {
    return false;
  }
}
