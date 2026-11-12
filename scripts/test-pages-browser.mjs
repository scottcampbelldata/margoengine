// Drives the test pages in examples/test-pages/ (all but the integration-* pages, which
// scripts/integration-browser-tests.mjs runs) the way a user would: open the page, wait for its start, click every
// enabled button in order and wait for the work each click starts. A page passes when nothing went wrong: no uncaught
// error, no rejected promise, no console error and no console warning that says BUG (examples/test-pages/page-harness.ts
// records them). A finding that matches an open bug in KNOWN is reported as a known failure naming its bug row and
// does not fail the run; a known bug that no longer shows fails the run, so its row gets closed.
//
// Usage: node scripts/test-pages-browser.mjs [--page=<name>] [--limit=<ms per page>] (MARGO_COMPAT=1 runs the WebGL2
// compatibility layer).
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';
import { runScene } from './support/composition-run.mjs';
import { compatRun } from './support/compat-shim.js';

const root = join(import.meta.dirname, '..');
const dir = join(root, 'examples/test-pages');

/** Buttons a run never clicks: they only clear the page log. */
const SKIP_BUTTONS = new Set(['btnClearLog']);

/**
 * Open bugs a page still shows: { page, match, row }. `row` is the bug id in docs/known-bugs.md. Each entry is removed
 * by the change that fixes its bug.
 * @type {{ page: string, match: RegExp, row: string }[]}
 */
export const KNOWN = [];

/** The page names, from the HTML files in examples/test-pages/. */
export function pageNames(files = readdirSync(dir)) {
  return files
    .filter((f) => f.endsWith('.html') && !f.startsWith('integration-'))
    .map((f) => f.slice(0, -'.html'.length))
    .sort();
}

/** Splits findings into known failures and unexpected ones, and lists the known rows that did not show. */
export function classify(page, findings, known = KNOWN) {
  const mine = known.filter((k) => k.page === page);
  const seen = new Set();
  const expected = [];
  const unexpected = [];
  for (const finding of findings) {
    const hit = mine.find((k) => k.match.test(finding.text));
    if (hit) {
      seen.add(hit);
      expected.push({ ...finding, row: hit.row });
    } else unexpected.push(finding);
  }
  return { expected, unexpected, gone: mine.filter((k) => !seen.has(k)).map((k) => k.row) };
}

/** The most one page (start, every click and its work) may take. */
const PAGE_LIMIT_MS = Number(
  process.argv.find((arg) => arg.startsWith('--limit='))?.slice('--limit='.length) ?? 120_000,
);
/**
 * Pages that need longer. The path-traced still waits for the tracer's programs, and on the WebGL2 layer under ANGLE
 * Direct3D 11 the driver compiles them at their first draw for up to about two minutes (docs/limits.md, "Voxel path
 * tracer on the WebGL2 compatibility layer"); its capture click measured 134 s there on 2026-11-11.
 */
const PAGE_LIMITS_MS = { 'pathtraced-still-xr': 300_000 };

async function runPage(name, compat) {
  const findings = [];
  let clicked = 0;
  let step = 'start';
  const browser = await openBrowser({ startPath: `/examples/test-pages/${name}.html`, port: 'free', compat });
  browser.page.on('pageerror', (error) => findings.push({ kind: 'error', text: `pageerror: ${error.message}` }));
  try {
    await runScene(
      async () => {
        await browser.page.waitForFunction(() => !!window.testPage, null, { timeout: 60_000 });
        await browser.page.evaluate(() => window.testPage.settle());
        const buttons = await browser.page.evaluate(() => window.testPage.buttons());
        for (const id of buttons) {
          if (SKIP_BUTTONS.has(id)) continue;
          step = `button ${id}`;
          const began = performance.now();
          await browser.page.evaluate((button) => window.testPage.click(button), id);
          // Diagnostic only, never asserted: a click whose work takes long is worth a look.
          const took = performance.now() - began;
          if (took > 10_000) console.log(`note ${name}: button ${id} took ${Math.round(took / 1000)} s`);
          clicked++;
        }
        findings.push(...(await browser.page.evaluate(() => window.testPage.findings())));
        return buttons.length;
      },
      {
        label: `${name} ${compat ? 'webgl2-compat' : 'webgpu'}`,
        limitMs: Math.max(PAGE_LIMIT_MS, PAGE_LIMITS_MS[name] ?? 0),
        probe: () => step,
      },
    );
  } catch (error) {
    findings.push({ kind: 'error', text: `runner: ${error.message}` });
  } finally {
    await browser.close();
  }
  return { findings, clicked };
}

async function main() {
  const compat = compatRun();
  const backend = compat ? 'webgl2-compat' : 'webgpu';
  const given = process.argv.find((arg) => arg.startsWith('--page='))?.slice('--page='.length);
  const names = pageNames();
  assert.ok(!given || names.includes(given), `unknown test page ${given}; pages: ${names.join(', ')}`);
  const results = [];
  let failed = 0;
  const release = await acquire({ owner: 'test-pages', waitMax: 1 });
  try {
    for (const name of given ? [given] : names) {
      const { findings, clicked } = await runPage(name, compat);
      const { expected, unexpected, gone } = classify(name, findings);
      for (const k of expected) console.log(`KNOWN FAIL ${name} ${backend} (${k.row}): ${k.text}`);
      for (const f of unexpected) console.log(`FAIL ${name} ${backend}: ${f.kind}: ${f.text}`);
      for (const row of gone) console.log(`FAIL ${name} ${backend}: known bug ${row} no longer shows; close its row`);
      const ok = unexpected.length === 0 && gone.length === 0;
      if (!ok) failed++;
      else
        console.log(
          `PASS ${name} ${backend}, ${clicked} buttons${expected.length ? `, ${expected.length} known` : ''}`,
        );
      results.push({ page: name, backend, ok, clicked, expected, unexpected, gone });
    }
  } finally {
    await release();
  }
  mkdirSync(join(root, 'test-results'), { recursive: true });
  writeFileSync(
    join(root, `test-results/test-pages-${given ?? 'all'}-${backend}.json`),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  console.log(`${results.length - failed} of ${results.length} test pages passed on ${backend}`);
  if (failed) process.exitCode = 1;
}

if (/test-pages-browser\.mjs$/.test(process.argv[1] ?? '')) await main();
