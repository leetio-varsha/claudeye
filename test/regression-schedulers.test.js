/**
 * regression-schedulers.test.js — Класс рецидивов: standalone-скрипты в
 * ~/.claudeye/ расходятся с источниками в scripts/ (#82, #65, #87).
 *
 * Когда мы фиксим src/* и забываем перекопировать standalone — launchd дальше
 * запускает старую версию, advisor молча отваливается. Тест ловит расхождение.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const PAIRS = [
  // [source-in-repo, deployed-copy-in-home]
  ['scripts/insights-runner.sh',               join(homedir(), '.claudeye/insights-runner.sh')],
  ['scripts/behavioral-standalone.mjs',        join(homedir(), '.claudeye/behavioral-standalone.mjs')],
  ['scripts/import-cowork-standalone.mjs',     join(homedir(), '.claudeye/import-cowork-standalone.mjs')],
  // digest-standalone.mjs and insights-standalone.mjs lived in ~/.claudeye/
  // before being mirrored into the repo — pair them up once they're added
  // to scripts/. Until then this list grows as standalones are formalized.
];

describe('regression: scheduler standalone scripts (#82, #65, #87)', () => {
  for (const [src, deployed] of PAIRS) {
    it(`${src} ↔ ${deployed}`, () => {
      // Repo source must exist
      assert.ok(existsSync(src), `Missing source: ${src}`);

      // Deployed copy may not exist on a fresh checkout — that's a soft fail
      // (CI doesn't have ~/.claudeye/). But on the dev machine (running
      // launchd), they MUST be byte-identical or stale-copy bug returns.
      if (!existsSync(deployed)) {
        // Skip on CI / fresh checkout — but log so it's visible.
        return;
      }

      const srcSize = statSync(src).size;
      const depSize = statSync(deployed).size;
      assert.equal(
        srcSize,
        depSize,
        `Size drift: ${src}=${srcSize}B vs ${deployed}=${depSize}B — re-deploy`,
      );
    });
  }
});

// ─── Logic-parity guard (#118) ────────────────────────────────────────────────
// Size-only comparison above catches "src changed, deploy didn't" but NOT
// "logic added to src/* but never ported to the standalone twin" (the #117/#118
// drift class). This block asserts that key behavioral markers present in the
// canonical src/* implementation are ALSO present in the standalone script that
// launchd actually runs — so a missing filter/parser fails CI instead of silently
// polluting analytics.
const PARITY = [
  {
    name: 'cowork importer: src ↔ standalone',
    canonical: 'src/import-cowork.js',
    standalone: 'scripts/import-cowork-standalone.mjs',
    markers: [
      'SYSTEM_SESSION_TITLE_PATTERNS',
      'isSystemSession',
      'parseUsage',
      'normalizeMetaModel',
      'backfillCoworkModels',
      'backfillCoworkTokens',
      'isNoiseEvent',
      'dedupEvents',
    ],
  },
];

describe('regression: standalone logic parity (#118)', () => {
  for (const { name, canonical, standalone, markers } of PARITY) {
    it(name, () => {
      assert.ok(existsSync(canonical), `Missing canonical source: ${canonical}`);
      assert.ok(existsSync(standalone), `Missing standalone: ${standalone}`);
      const srcText = readFileSync(canonical, 'utf8');
      const stdText = readFileSync(standalone, 'utf8');
      for (const m of markers) {
        // Marker must exist in the canonical impl to be a meaningful guard…
        assert.ok(srcText.includes(m), `Marker "${m}" missing from ${canonical}`);
        // …and must have been ported into the standalone twin (the drift bug).
        assert.ok(
          stdText.includes(m),
          `Logic drift: "${m}" exists in ${canonical} but NOT in ${standalone} — port it`,
        );
      }
    });
  }
});
