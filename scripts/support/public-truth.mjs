// Public statements that must match their source: the licence in the site's structured data (package.json and LICENSE
// are the source), every stated count of packages (docs/catalog.json is the source: one entry per package under
// packages/), the white paper's test count (examples/package-benchmarks/results/test-count.json, written from a measured
// `npm run verify`) and its statement about `unsafe-eval` (the code of packages/webgl2-compat and its README). `node scripts/support/public-truth.mjs` prints problems and exits 1; tests/public-truth.test.js runs the
// same functions on the repo (so `npm run verify` and `check:merge` fail on a mismatch) and on planted mismatches.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The URLs that name each SPDX id in structured data, and the text every LICENSE file of that id contains. */
export const LICENSES = {
  'Apache-2.0': {
    urls: ['https://www.apache.org/licenses/LICENSE-2.0', 'https://opensource.org/license/apache-2-0'],
    text: /Apache License\s+Version 2\.0/,
  },
};

/** The `license` value of every JSON-LD block in a page (a string, or an object's `@id` or `url`). */
export function jsonLdLicenses(html) {
  const found = [];
  for (const match of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    const walk = (value) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object')
        for (const [key, item] of Object.entries(value)) {
          if (key === 'license') found.push(typeof item === 'string' ? item : (item?.['@id'] ?? item?.url ?? ''));
          else walk(item);
        }
    };
    walk(JSON.parse(match[1]));
  }
  return found;
}

/** Problems with the licence statements of one page against package.json's `license` and the LICENSE text. */
export function licenceProblems({ html, page, license, licenseText }) {
  const known = LICENSES[license];
  if (!known) return [`package.json license ${license} has no entry in scripts/support/public-truth.mjs LICENSES`];
  const problems = [];
  if (!known.text.test(licenseText)) problems.push(`LICENSE is not the ${license} text that package.json declares`);
  const stated = jsonLdLicenses(html);
  if (!stated.length) problems.push(`${page}: no JSON-LD license; add "license":"${known.urls[0]}"`);
  for (const url of stated)
    if (!known.urls.includes(url))
      problems.push(`${page}: JSON-LD license ${url} differs from package.json (${license}); use ${known.urls[0]}`);
  return problems;
}

/** Phrases that state how many packages there are in all; the number is the first capture group. */
const COUNT_PHRASES = [
  /\b(\d[\d,]*) packages in \d+ layers/g,
  /\b(?:Search all|all|includes|lists|has) (\d[\d,]*) (?:optional )?packages\b/gi,
  /\b(\d[\d,]*) (?:optional )?packages \(none published/g,
  /^(\d[\d,]*) packages, \d[\d,]* entries/gm,
  /<b>(\d[\d,]*)<\/b><span>(?:optional )?packages/g,
];

/** Problems with the stated package counts in `files` ({path: text}) against the catalog's length. */
export function packageCountProblems(files, total) {
  const problems = [];
  for (const [path, text] of Object.entries(files))
    for (const phrase of COUNT_PHRASES)
      for (const match of text.matchAll(phrase)) {
        const stated = Number(match[1].replaceAll(',', ''));
        if (stated !== total)
          problems.push(`${path}: states ${stated} packages, the catalog has ${total} (${match[0].trim()})`);
      }
  return problems;
}

/** Files that state a package count in public (the HTML pages under site/whitepaper are added by name). */
export const COUNT_FILES = [
  'README.md',
  'docs/README.md',
  'docs/limits.md',
  'docs/releasing.md',
  'docs/api-surface.md',
  'docs/whitepaper/claims.md',
  'site/index.html',
  'site/llms.txt',
  'site/llms-full.txt',
];

/** Where the measured Node test count lives; the white paper's statements are checked against it. */
export const TEST_COUNT_FILE = 'examples/package-benchmarks/results/test-count.json';
/** Public files that state the Node test count. */
export const TEST_COUNT_FILES = ['site/whitepaper/engine.html', 'docs/whitepaper/claims.md'];

const number = (text) => Number(text.replaceAll(',', ''));

// The statements of the test count. A headline in the white paper's ledger, a sentence in its "Tests and checks" list
// and the row of docs/whitepaper/claims.md; each has the count, then "N pass, M skipped" (not run past its own element).
const HEADLINE = /<b>(\d[\d,]*)<\/b><span>Node tests(?:(?!<\/span>)[^])*?(\d[\d,]*) pass, (\d[\d,]*) skipped/g;
const SENTENCE = /<strong>(\d[\d,]*) Node tests<\/strong>(?:(?!<\/li>)[^])*?(\d[\d,]*) pass, (\d[\d,]*) skipped/g;
const CLAIMS_ROW = /\| engine \| (\d[\d,]*) tests, (\d[\d,]*) pass, (\d[\d,]*) skipped/g;
const HANDOFF_LINE = /(Test count re-measured: )(\d[\d,]*) tests, (\d[\d,]*) pass, (\d[\d,]*) skipped/g;
const withCommas = (value) => value.toLocaleString('en-US');

/**
 * The text with every test-count statement rewritten to `measured` ({tests, pass, skipped, commit}) and the commit
 * `was` replaced by the measured one where a statement names it ("tests at", "at commit", "· hash", "(Node 26.12,
 * `hash`)", "at `hash`"). Used by scripts/record-test-count.mjs; testCountProblems then finds nothing to report.
 */
export function restateTestCount(text, measured, was) {
  const now = measured.commit,
    counts = (all, tests, pass, skipped) =>
      all
        .replace(tests, withCommas(measured.tests))
        .replace(
          `${pass} pass, ${skipped} skipped`,
          `${withCommas(measured.pass)} pass, ${withCommas(measured.skipped)} skipped`,
        );
  let out = text;
  for (const phrase of [HEADLINE, SENTENCE, CLAIMS_ROW])
    out = out.replace(phrase, (all, tests, pass, skipped) => counts(all, tests, pass, skipped));
  out = out.replace(HANDOFF_LINE, (all, _lead, tests, pass, skipped) => counts(all, tests, pass, skipped));
  if (was)
    for (const [from, to] of [
      [`tests at ${was}`, `tests at ${now}`],
      [`at commit ${was}`, `at commit ${now}`],
      [`results/test-count.json · ${was}`, `results/test-count.json · ${now}`],
      [`(Node 26.12, \`${was}\`)`, `(Node 26.12, \`${now}\`)`],
      [`at \`${was}\` (\`results/test-count.json\`)`, `at \`${now}\` (\`results/test-count.json\`)`],
    ])
      out = out.split(from).join(to);
  return out.replaceAll(
    /the (\d[\d,]*) tests, quality gates/g,
    () => `the ${withCommas(measured.tests)} tests, quality gates`,
  );
}

/**
 * Problems with the Node test counts stated in `files` ({path: text}) against `measured`
 * ({tests, pass, skipped, commit}, the test-count.json record): the headline number, the "N pass, M skipped" that
 * follows it, and the commit named beside it. A page that states a count must name the measured commit too.
 */
export function testCountProblems(files, measured) {
  const problems = [],
    short = String(measured.commit ?? '');
  if (!/^[0-9a-f]{7,40}$/.test(short)) problems.push(`test-count.json: commit "${short}" is not a commit hash`);
  const statements = [
    // <b>6,373</b><span>Node tests ... 6,371 pass, 2 skipped
    HEADLINE,
    // <strong>6,373 Node tests</strong> in every <code>npm run verify</code> at ec3f9b52: 6,371 pass, 2 skipped
    SENTENCE,
    // | engine | 6,373 tests, 6,371 pass, 2 skipped (Node 26.12, `ec3f9b52`) |
    CLAIMS_ROW,
  ];
  for (const [path, text] of Object.entries(files)) {
    let stated = 0;
    for (const phrase of statements)
      for (const match of text.matchAll(phrase)) {
        stated++;
        const [tests, pass, skipped] = match.slice(1).map(number);
        if (tests !== measured.tests || pass !== measured.pass || skipped !== measured.skipped)
          problems.push(
            `${path}: states ${tests} tests, ${pass} pass, ${skipped} skipped; ${TEST_COUNT_FILE} measured ${measured.tests}, ${measured.pass}, ${measured.skipped} at ${short}`,
          );
      }
    // Any other "N tests" in a sentence about verify (the command listing, the byline).
    for (const match of text.matchAll(/the (\d[\d,]*) tests, quality gates/g)) {
      stated++;
      if (number(match[1]) !== measured.tests)
        problems.push(`${path}: states ${match[1]} tests, ${TEST_COUNT_FILE} measured ${measured.tests} at ${short}`);
    }
    if (stated && !text.includes(short))
      problems.push(`${path}: states a test count but does not name the commit it was measured at (${short})`);
    for (const match of text.matchAll(/tests at ([0-9a-f]{7,40})/g))
      if (match[1] !== short)
        problems.push(`${path}: says tests were counted at ${match[1]}, ${TEST_COUNT_FILE} says ${short}`);
  }
  return problems;
}

/** Whether source text builds code at run time (what a Content-Security-Policy without `'unsafe-eval'` refuses). */
export const buildsCodeAtRunTime = (source) =>
  /\bnew Function\s*\(|(?<![.\w])eval\s*\(|\bFunction\s*\(\s*['"`]/.test(source);

/** A sentence that says no package builds code at run time. */
const NOTHING_BUILDS_CODE = /\bno package source uses\b[^.\n]{0,80}\bnew Function/i;

/** A sentence that says nothing needs `unsafe-eval`, without qualification. */
const NOTHING_NEEDS_EVAL = /\b(?:nothing|no file|no package|none)\b[^.\n]{0,80}\bunsafe-eval/i;

/**
 * Problems with what the public pages say about `'unsafe-eval'`: the optional WebGL2 CPU compute tier builds its
 * shaders with `new Function` and needs it (packages/webgl2-compat/README.md says so), so a page may not say that
 * nothing needs it unless the same sentence names the CPU compute tier, and a page that mentions `unsafe-eval` must say so
 * where the code does it. `compat` is { readme, sources: {path: text} }; `pages` is {path: text}.
 */
export function unsafeEvalProblems(pages, compat) {
  const problems = [],
    needs = Object.entries(compat.sources).filter(([, text]) => buildsCodeAtRunTime(text)),
    readmeSays = /unsafe-eval/.test(compat.readme);
  if (needs.length && !readmeSays)
    problems.push(
      `packages/webgl2-compat/README.md does not say that the CPU compute tier needs 'unsafe-eval', but ${needs.map(([p]) => p).join(', ')} builds code at run time`,
    );
  if (!needs.length && readmeSays)
    problems.push(
      "packages/webgl2-compat/README.md says it needs 'unsafe-eval' but no source there builds code at run time any more: update the README and the pages that repeat it",
    );
  for (const [path, text] of Object.entries(pages)) {
    // A sentence is a run up to a full stop followed by a space and a capital, or a line end.
    const sentences = text.replace(/<[^>]+>/g, '').split(/(?<=\.)\s+(?=[A-Z|])|\n/);
    for (const sentence of sentences) {
      if (
        (NOTHING_NEEDS_EVAL.test(sentence.replaceAll("'wasm-unsafe-eval'", 'wasm directive')) ||
          NOTHING_BUILDS_CODE.test(sentence)) &&
        needs.length
      ) {
        const qualified =
          /CPU compute tier|CPU tier/i.test(sentence) || /\bexcept\b|\bapart from\b|\bbesides\b/i.test(sentence);
        if (!qualified)
          problems.push(
            `${path}: says nothing needs 'unsafe-eval', but the optional WebGL2 CPU compute tier does (webgl2-compat builds code with new Function): "${sentence.trim().slice(0, 120)}"`,
          );
      }
    }
    if (needs.length && /unsafe-eval/.test(text) && /whitepaper/.test(path) && !/CPU compute tier/i.test(text))
      problems.push(`${path}: mentions 'unsafe-eval' but never says the optional WebGL2 CPU compute tier needs it`);
  }
  return problems;
}

/** Public files that say what needs `'unsafe-eval'` (the white paper pages are added by name). */
export const UNSAFE_EVAL_FILES = [
  'docs/deploying.md',
  'docs/limits.md',
  'docs/security.md',
  'docs/whitepaper/claims.md',
  'README.md',
];

/** All problems in a checkout rooted at `root`. */
export function publicTruthProblems(root = resolve(import.meta.dirname, '..', '..')) {
  const read = (path) => readFileSync(join(root, path), 'utf8');
  const pkg = JSON.parse(read('package.json')),
    catalog = JSON.parse(read('docs/catalog.json'));
  const pages = [
    'site/index.html',
    ...readdirSync(join(root, 'site/whitepaper')).map((name) => `site/whitepaper/${name}`),
  ].filter((path) => path.endsWith('.html'));
  const problems = [];
  for (const page of pages) {
    const html = read(page);
    if (!/application\/ld\+json/.test(html)) continue;
    problems.push(...licenceProblems({ html, page, license: pkg.license, licenseText: read('LICENSE') }));
  }
  const files = {};
  for (const path of [...COUNT_FILES, ...pages]) if (existsSync(join(root, path))) files[path] = read(path);
  problems.push(...packageCountProblems(files, catalog.length));
  const counted = {};
  for (const path of TEST_COUNT_FILES) if (existsSync(join(root, path))) counted[path] = read(path);
  problems.push(...testCountProblems(counted, JSON.parse(read(TEST_COUNT_FILE))));
  const compatDir = 'packages/webgl2-compat';
  if (existsSync(join(root, compatDir, 'README.md'))) {
    const sources = {};
    for (const entry of readdirSync(join(root, compatDir, 'src'), { recursive: true }))
      if (/\.(ts|js|mjs)$/.test(entry) && !/\.d\.ts$/.test(entry))
        sources[`${compatDir}/src/${String(entry).replaceAll('\\', '/')}`] = read(`${compatDir}/src/${entry}`);
    const prose = {};
    for (const path of [...UNSAFE_EVAL_FILES, ...pages]) if (existsSync(join(root, path))) prose[path] = read(path);
    problems.push(...unsafeEvalProblems(prose, { readme: read(`${compatDir}/README.md`), sources }));
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const problems = publicTruthProblems();
  if (problems.length) {
    console.error(`public-truth: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log("public-truth: licence, package counts, test count and the 'unsafe-eval' statement match");
}
