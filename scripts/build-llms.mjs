// Writes site/llms.txt and site/llms-full.txt, the files AI coding tools read to learn Margo (https://llmstxt.org).
//   node scripts/build-llms.mjs            rewrite both files from the READMEs, api/ reports and docs/
//   node scripts/build-llms.mjs --check    exit 1 when either file is stale (tests/llms.test.js runs the same check)
// llms.txt: title, summary, then sections of links with one-line descriptions. llms-full.txt: the same material as
// one text file (guides in full, each package README up to a cap). The pages the links point at (/llms/...) are
// written into site/dist by scripts/build-site.js with writeSitePages().
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GUIDES, SITE, clip, collectCorpus } from './support/llms-corpus.mjs';

const root = resolve(import.meta.dirname, '..');
/** Longest README text llms-full.txt keeps per package; the page behind the package link has all of it. */
export const README_CAP = 5000;

const pageOf = {
  readme: (id) => `${SITE}/llms/packages/${id}.md`,
  api: (id) => `${SITE}/llms/api/${id}.md`,
  doc: (path) => `${SITE}/llms/${path}`,
};

const apiText = (pkg) => pkg.entries.map((entry) => entry.report.trimEnd()).join('\n\n');

/** README text cut at a paragraph boundary near `README_CAP`, with a pointer to the whole page. */
function capped(pkg) {
  const text = pkg.readme.trim();
  if (text.length <= README_CAP) return text;
  const cut = text.slice(0, README_CAP),
    boundary = cut.lastIndexOf('\n\n');
  const body = cut.slice(0, boundary > README_CAP / 2 ? boundary : README_CAP).trimEnd();
  // A cut inside a code fence would swallow the rest of the file as code; close it.
  const closed = (body.match(/^```/gm)?.length ?? 0) % 2 ? body + '\n```' : body;
  return `${closed}\n\n[README continues: ${pageOf.readme(pkg.id)}]`;
}

/** The llms.txt text. */
export function renderLlmsTxt(corpus) {
  const line = (title, url, description) => `- [${title}](${url})${description ? `: ${description}` : ''}`;
  const out = [
    '# Margo Engine',
    '',
    '> Margo Engine is a WebGPU 3D engine for the web, written in TypeScript with a small Wasm kernel. `@margoengine/core` plus the stage facade (`margoengine`) stay under 25,000 bytes gzip; everything else (glTF PBR, animation, post-processing, physics, CAD, voxels, GPU compute, scientific visualisation) is a separate, optional, tree-shakable package. ESM only, full types, glTF and real-world units by default, `AbortSignal` on anything that loads, coded errors with a help link.',
    '',
    'Import the stage for a canvas, camera, controls and loading in a few lines (`import { createStage } from "margoengine"`), or the engine for full control (`import { Engine } from "@margoengine/core"`). Add a feature by importing its package; `margoengine/<name>` and `@margoengine/<name>` are the same module. Without WebGPU, `@margoengine/webgl2-compat` runs the real renderer on WebGL2; its optional `/preview` entry draws basic scenes on lower-tier WebGL2. Margo is written clean room: it does not copy or adapt code from other engines. The `@margoengine/mcp` package is a Model Context Protocol server that gives AI tools these docs, a type-check for snippets and the example list.',
    '',
    '## Start here',
    '',
    line(
      'Full documentation as one file',
      `${SITE}/llms-full.txt`,
      'guides in full and each package README (long ones cut), for tools that take a single text',
    ),
    line('Package index', `${SITE}/catalog/`, 'searchable list of every package, its imports and runtime exports'),
    line('Error help', `${SITE}/errors`, 'cause and fix for every coded error message'),
    line('Examples', pageOf.doc('examples.md'), 'runnable example pages and projects'),
    '',
    '## Guides',
    '',
    ...GUIDES.filter(([path]) => corpus.docs.some((doc) => doc.path === path)).map(([path, description]) => {
      const doc = corpus.docs.find((candidate) => candidate.path === path);
      return line(doc.title, pageOf.doc(path), description);
    }),
    '',
  ];
  const categories = [...new Set(corpus.packages.map((pkg) => pkg.category))];
  for (const category of categories) {
    out.push(`## Packages: ${category}`, '');
    for (const pkg of corpus.packages.filter((candidate) => candidate.category === category))
      out.push(line(pkg.name, pageOf.readme(pkg.id), clip(pkg.description, 170)));
    out.push('');
  }
  out.push(
    '## API reference',
    '',
    'One page per package: every exported name with its declaration, generated from the compiled types (`npm run api:check` fails when it changes by accident).',
    '',
    ...corpus.packages
      .filter((pkg) => pkg.entries.length)
      .map((pkg) =>
        line(
          `${pkg.name} API`,
          pageOf.api(pkg.id),
          `${pkg.entries.length} entry point${pkg.entries.length === 1 ? '' : 's'}`,
        ),
      ),
    '',
    '## Optional',
    '',
    ...corpus.docs
      .filter((doc) => !GUIDES.some(([path]) => path === doc.path))
      .map((doc) => line(doc.title, pageOf.doc(doc.path), clip(doc.summary, 140))),
    '',
  );
  return out.join('\n');
}

/** The llms-full.txt text. */
export function renderLlmsFull(corpus) {
  const section = (title, body) => `\n\n${'='.repeat(3)} ${title} ${'='.repeat(3)}\n\n${body.trim()}`;
  const parts = [
    '# Margo Engine: full documentation for AI tools\n\n> Generated by scripts/build-llms.mjs from the package READMEs, api/ reports and docs/. The shorter index is llms.txt. Package READMEs longer than ' +
      README_CAP +
      ' characters are cut; the link at the cut has the rest, and each package has an API page with every declaration.',
    section('Repository README (README.md)', corpus.readme),
  ];
  for (const [path] of GUIDES) {
    const doc = corpus.docs.find((candidate) => candidate.path === path);
    if (doc) parts.push(section(`${doc.title} (${path})`, doc.text));
  }
  for (const pkg of corpus.packages)
    if (pkg.readme.trim()) parts.push(section(`${pkg.name} (packages/${pkg.id}/README.md)`, capped(pkg)));
  parts.push(section('Examples (examples/README.md)', renderExamples(corpus)));
  return parts.join('') + '\n';
}

/** The example list as markdown (llms/examples.md and the end of llms-full.txt). */
export function renderExamples(corpus) {
  const out = ['# Margo Engine examples', ''];
  for (const section of [...new Set(corpus.examples.map((example) => example.section))]) {
    out.push(`## ${section}`, '');
    for (const example of corpus.examples.filter((candidate) => candidate.section === section))
      out.push(`- \`${example.path}\`: ${example.description}`);
    out.push('');
  }
  out.push(
    'Run from a repository checkout: `npm run build:packages`, then `npm run dev:examples` (pages) or the command in each project table.',
  );
  return out.join('\n');
}

/** Every file of the site's /llms/ folder: path (relative to the site root) to text. */
export function sitePages(corpus) {
  const pages = new Map();
  for (const pkg of corpus.packages) {
    if (pkg.readme.trim()) pages.set(`llms/packages/${pkg.id}.md`, pkg.readme);
    if (pkg.entries.length) pages.set(`llms/api/${pkg.id}.md`, apiText(pkg) + '\n');
  }
  for (const doc of corpus.docs) pages.set(`llms/${doc.path}`, doc.text);
  pages.set('llms/examples.md', renderExamples(corpus) + '\n');
  return pages;
}

/** Writes the /llms/ pages under `outDir` (the built site). */
export function writeSitePages(outDir, corpus = collectCorpus(root)) {
  const pages = sitePages(corpus);
  for (const [path, text] of pages) {
    mkdirSync(dirname(join(outDir, path)), { recursive: true });
    writeFileSync(join(outDir, path), text);
  }
  return pages.size;
}

/** The two committed files, as `{ path: text }`. */
export function generate(dir = root) {
  const corpus = collectCorpus(dir);
  return { 'site/llms.txt': renderLlmsTxt(corpus), 'site/llms-full.txt': renderLlmsFull(corpus) };
}

/** Paths of committed files that differ from what `generate` makes. */
export function stale(dir = root) {
  return Object.entries(generate(dir))
    .filter(([path, text]) => {
      try {
        return readFileSync(join(dir, path), 'utf8').replaceAll('\r\n', '\n') !== text;
      } catch {
        return true;
      }
    })
    .map(([path]) => path);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--check')) {
    const paths = stale();
    if (paths.length) {
      console.error(`${paths.join(' and ')} stale: run node scripts/build-llms.mjs and commit the result`);
      process.exitCode = 1;
    } else console.log('site/llms.txt and site/llms-full.txt are current');
  } else {
    for (const [path, text] of Object.entries(generate())) {
      writeFileSync(join(root, path), text);
      console.log(`${path}: ${text.length} characters`);
    }
  }
}
