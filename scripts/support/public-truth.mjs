// Public statements that must match their source: the licence in the site's structured data (package.json and LICENSE
// are the source) and every stated count of packages (docs/catalog.json is the source: one entry per package under
// packages/). `node scripts/support/public-truth.mjs` prints problems and exits 1; tests/public-truth.test.js runs the
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
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const problems = publicTruthProblems();
  if (problems.length) {
    console.error(`public-truth: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log('public-truth: licence and package counts match');
}
