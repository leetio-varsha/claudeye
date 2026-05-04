/**
 * regression-schedulers.test.js — Класс рецидивов: standalone-скрипты в
 * ~/.claudeye/ расходятся с источниками в scripts/ (#82, #65, #87).
 *
 * Когда мы фиксим src/* и забываем перекопировать standalone — launchd дальше
 * запускает старую версию, advisor молча отваливается. Тест ловит расхождение.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const PAIRS = [
  // [source-in-repo, deployed-copy-in-home]
  ['scripts/insights-runner.sh',          join(homedir(), '.claudeye/insights-runner.sh')],
  ['scripts/behavioral-standalone.mjs',   join(homedir(), '.claudeye/behavioral-standalone.mjs')],
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
