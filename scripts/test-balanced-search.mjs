#!/usr/bin/env node
import { getDb, getObservationsWithEmbeddings } from '../src/db.js';
const db = getDb();

// Count git-commit vs hook observations
const total = db.prepare("SELECT COUNT(*) as n FROM observations").get().n;
const git = db.prepare("SELECT COUNT(*) as n FROM observations WHERE tool = 'git-commit'").get().n;
const hook = total - git;
console.log(`Total: ${total}  Git: ${git} (${Math.round(git/total*100)}%)  Hook: ${hook} (${Math.round(hook/total*100)}%)`);

// Test balanced sampling
const rows = getObservationsWithEmbeddings(null, 300);
const gitRows = rows.filter(r => r.tool === 'git-commit').length;
const hookRows = rows.filter(r => r.tool !== 'git-commit').length;
console.log(`Balanced sample: git: ${gitRows}  hook: ${hookRows}  total: ${rows.length}`);
console.log(`Before fix: git would be ~${Math.round(git / total * 300)} of 300`);
console.log(`After fix: git capped at 50, hooks get ${hookRows} slots`);
