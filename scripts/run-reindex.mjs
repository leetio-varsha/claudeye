#!/usr/bin/env node
/**
 * Standalone reindex script — can be run directly or via `node scripts/run-reindex.mjs`
 * Writes result to /tmp/reindex-result.json
 */
import { reindex } from '../src/reindex.js';
import { writeFileSync } from 'fs';

try {
  const r = await reindex({
    batchSize: 100,
    delayMs: 300,
    onProgress: ({ done, total }) => {
      process.stdout.write(`\r  ${done}/${total}`);
    },
  });
  console.log('\nDone:', JSON.stringify(r));
  writeFileSync('/tmp/reindex-result.json', JSON.stringify(r, null, 2));
} catch (e) {
  console.error('Error:', e.message);
  writeFileSync('/tmp/reindex-result.json', JSON.stringify({ error: e.message }));
  process.exit(1);
}
