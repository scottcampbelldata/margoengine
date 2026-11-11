// Checks that margoengine.com/errors (site/errors.html) and the coded throws of the listed packages agree:
//   - the committed page is what scripts/errors/page.mjs writes from scripts/errors/entries.js;
//   - entry ids are unique anchors;
//   - every fault(code, message[, anchor]), typeError(message, anchor) and rangeError(message, anchor) links to an
//     entry, a fault code has a code entry, and a literal message is listed under the entry it links to.
// tests/errors-page.test.js runs it, and so does `npm run hygiene` (assertErrorPageCurrent), because the fast gate runs
// hygiene on every push while a lane runs only its own package tests: a sciviz message once reached main unlisted
// (KB-ERR1) because no sciviz test read the page.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { entries as allEntries } from './entries.js';
import { errorsPage } from './page.mjs';

/** Source folders whose throws must link to the page and list their literal messages there. */
export const ERROR_SOURCES = [
  'packages/core/src',
  'packages/stage/src',
  'packages/compute/src',
  'packages/sciviz/src',
  'packages/ui/src',
  'packages/mcp/src',
  'packages/biomes/src',
  'packages/cache/src',
];

// fault('code', message[, 'anchor']), typeError(message, 'anchor'), rangeError(message, 'anchor').
const CALL =
  /\b(?:(fault)\(\s*'(\w+)',\s*|(typeError|rangeError)\(\s*)('[^']*'|"[^"]*"|`[^`]*`|\w+(?:\.\w+)*)(?:,\s*'([\w-]+)')?,?\s*\)/g;

/**
 * Every disagreement between the page, its entries and the throws under `root`, plus the number of throw sites read.
 * `entries` and `page` default to the real ones; tests pass their own.
 */
export function errorPageFindings(root, { entries = allEntries, page = errorsPage() } = {}) {
  const findings = [],
    ids = new Map(entries.map((e) => [e.id, e])),
    pageFile = join(root, 'site/errors.html');
  if (!existsSync(pageFile) || readFileSync(pageFile, 'utf8').replace(/\r\n/g, '\n') !== page)
    findings.push('site/errors.html differs from scripts/errors/entries.js; run node scripts/errors/page.mjs');
  if (ids.size !== entries.length) findings.push('scripts/errors/entries.js: entry ids must be unique');
  for (const e of entries) if (!/^[a-z][a-z-]*$/.test(e.id)) findings.push(`${e.id}: anchor id needs [a-z-]`);
  let calls = 0;
  for (const dir of ERROR_SOURCES) {
    if (!existsSync(join(root, dir))) continue;
    for (const name of readdirSync(join(root, dir)).filter((f) => f.endsWith('.ts'))) {
      const file = `${dir}/${name}`,
        text = readFileSync(join(root, file), 'utf8');
      for (const m of text.matchAll(CALL)) {
        calls++;
        const [, faultCall, code, other, message, anchor] = m,
          id = anchor ?? code;
        if (!id) {
          findings.push(`${file}: ${m[0]} names no help anchor`);
          continue;
        }
        if (!ids.has(id)) {
          findings.push(`${file}: ${m[0]} links to #${id}, which site/errors.html lacks`);
          continue;
        }
        if ((faultCall ?? other) === 'fault' && ids.get(code)?.kind !== 'code')
          findings.push(`${file}: code '${code}' needs a code entry`);
        // A literal message is listed under the entry it links to, so the page names what developers see.
        if (/^['"]/.test(message) && !ids.get(id).messages.includes(message.slice(1, -1)))
          findings.push(`${file}: ${message} is not listed under #${id} in scripts/errors/entries.js`);
      }
    }
  }
  return { findings, calls };
}

/** Throws when the page and the throws disagree; the message lists each finding and the fix. */
export function assertErrorPageCurrent(root) {
  const { findings } = errorPageFindings(root);
  if (findings.length)
    throw new Error(
      `margoengine.com/errors is out of date (${findings.length}); add each message to its entry in ` +
        `scripts/errors/entries.js, then run node scripts/errors/page.mjs:\n  ${findings.join('\n  ')}`,
    );
}
