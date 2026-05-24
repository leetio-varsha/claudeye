/**
 * test/project-registry.test.js — Project Registry tests (#27)
 *
 * Tests: loadRegistry, registerProject, listProjects, unregisterProject, projectCount
 * Uses a tmp dir to avoid touching ~/.claudeye on the developer's machine.
 * HOME is overridden before the module import so all path helpers resolve to TEST_DIR.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─── Redirect registry to a tmp dir ──────────────────────────────────────────
// Override HOME before importing project-registry so homedir() calls inside
// the module resolve to our test directory.

const TEST_DIR  = join(tmpdir(), 'claudeye-registry-test-' + Date.now());
const ORIG_HOME = process.env.HOME;

mkdirSync(TEST_DIR, { recursive: true });
process.env.HOME = TEST_DIR;

const {
  loadRegistry,
  registerProject,
  listProjects,
  projectCount,
  unregisterProject,
} = await import('../src/project-registry.js');

const REGISTRY_PATH = join(TEST_DIR, '.claudeye', 'projects.json');

before(() => {
  // HOME already set above; just ensure dir exists
  mkdirSync(TEST_DIR, { recursive: true });
});

after(() => {
  process.env.HOME = ORIG_HOME;
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  // Remove registry file between tests for isolation
  try { rmSync(REGISTRY_PATH, { force: true }); } catch {}
});

// ─── loadRegistry ────────────────────────────────────────────────────────────

describe('loadRegistry', () => {
  it('returns empty registry when file does not exist', () => {
    const r = loadRegistry();
    assert.equal(r.version, 1);
    assert.deepEqual(r.projects, []);
  });

  it('returns empty registry when file is corrupt JSON', () => {
    mkdirSync(join(TEST_DIR, '.claudeye'), { recursive: true });
    writeFileSync(REGISTRY_PATH, 'not json', 'utf8');
    const r = loadRegistry();
    assert.deepEqual(r.projects, []);
  });
});

// ─── registerProject ─────────────────────────────────────────────────────────

describe('registerProject', () => {
  it('registers a new project', () => {
    const result = registerProject('/home/user/my-project');
    assert.equal(result, true);

    const r = loadRegistry();
    assert.equal(r.projects.length, 1);
    assert.equal(r.projects[0].path, '/home/user/my-project');
    assert.equal(r.projects[0].shortName, 'my-project');
    assert.ok(r.projects[0].firstSeen);
    assert.ok(r.projects[0].lastSeen);
  });

  it('returns false for falsy path', () => {
    assert.equal(registerProject(''), false);
    assert.equal(registerProject(null), false);
  });

  it('does not duplicate an existing project', () => {
    registerProject('/home/user/proj-a');
    registerProject('/home/user/proj-a');
    const r = loadRegistry();
    assert.equal(r.projects.length, 1);
  });

  it('is a no-op (returns false) when lastSeen is today', () => {
    registerProject('/home/user/proj-b');
    const result2 = registerProject('/home/user/proj-b');
    assert.equal(result2, false);
  });

  it('registers multiple distinct projects', () => {
    registerProject('/home/user/alpha');
    registerProject('/home/user/beta');
    registerProject('/home/user/gamma');
    const r = loadRegistry();
    assert.equal(r.projects.length, 3);
    const paths = r.projects.map(p => p.path);
    assert.ok(paths.includes('/home/user/alpha'));
    assert.ok(paths.includes('/home/user/beta'));
    assert.ok(paths.includes('/home/user/gamma'));
  });

  it('persists registry file to disk', () => {
    registerProject('/home/user/persisted');
    assert.ok(existsSync(REGISTRY_PATH));
    const raw = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
    assert.equal(raw.version, 1);
    assert.equal(raw.projects.length, 1);
  });
});

// ─── listProjects ─────────────────────────────────────────────────────────────

describe('listProjects', () => {
  it('returns empty array when no projects registered', () => {
    assert.deepEqual(listProjects(), []);
  });

  it('returns projects sorted by lastSeen descending', () => {
    registerProject('/home/user/older');

    // Manually set lastSeen to a past date to simulate stale entry
    const r = loadRegistry();
    r.projects[0].lastSeen = '2025-01-01T00:00:00.000Z';
    mkdirSync(join(TEST_DIR, '.claudeye'), { recursive: true });
    writeFileSync(REGISTRY_PATH, JSON.stringify(r, null, 2), 'utf8');

    registerProject('/home/user/newer');
    const list = listProjects();
    assert.equal(list[0].path, '/home/user/newer');
    assert.equal(list[1].path, '/home/user/older');
  });
});

// ─── projectCount ─────────────────────────────────────────────────────────────

describe('projectCount', () => {
  it('returns 0 with no registry', () => {
    assert.equal(projectCount(), 0);
  });

  it('returns correct count after registrations', () => {
    registerProject('/a');
    registerProject('/b');
    assert.equal(projectCount(), 2);
  });
});

// ─── unregisterProject ────────────────────────────────────────────────────────

describe('unregisterProject', () => {
  it('removes an existing project', () => {
    registerProject('/home/user/to-remove');
    const removed = unregisterProject('/home/user/to-remove');
    assert.equal(removed, true);
    assert.equal(projectCount(), 0);
  });

  it('returns false for unknown project', () => {
    const result = unregisterProject('/nonexistent');
    assert.equal(result, false);
  });

  it('returns false for falsy path', () => {
    assert.equal(unregisterProject(''), false);
    assert.equal(unregisterProject(null), false);
  });
});
