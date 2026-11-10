// The one reader of Margo's written documentation: package READMEs, API reports, docs/ pages and the example list.
// Two things are built from it and must agree:
//   - scripts/build-llms.mjs writes site/llms.txt and site/llms-full.txt (the llms.txt convention, https://llmstxt.org)
//   - packages/mcp/scripts/build-corpus.mjs writes the index that the @margoengine/mcp server searches.
// Pure file reading, no network, deterministic order, LF line endings.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

export const SITE = 'https://margoengine.com';

/** Docs pages that explain the engine as a whole, in the order llms.txt lists them: [file, one-line description]. */
export const GUIDES = [
  ['docs/api-overview.md', 'A short tour of the three levels (stage, engine, packages) with the code for each'],
  ['docs/conventions.md', 'Naming, errors, units and the rules every package follows'],
  ['docs/guides/walkthrough.md', 'Step-by-step first scene to a loaded model'],
  ['docs/guides/imports.md', 'Which import to use: margoengine/<name> versus @margoengine/<name>'],
  ['docs/guides/quality-tiers.md', 'High and low quality tiers and how a page picks one'],
  ['docs/guides/kits.md', 'Independent install profiles for games, web, visualization and React'],
  ['docs/guides/kit-migration.md', 'Install-to-frame review for developers coming from three.js'],
  [
    'docs/guides/asset-pipeline.md',
    'margo-convert build: optimise, compress and package models for the web and for Unity, Unreal, Godot and Roblox',
  ],
  ['docs/from-threejs.md', 'Moving from three.js: the same task in Margo, name by name'],
  ['docs/limits.md', 'Measured limits and sizes, with the commands that measure them'],
  ['docs/known-bugs.md', 'Open bugs with repro and cause'],
  ['docs/ai-tools.md', 'Using Margo with Claude, Cursor, Copilot and the @margoengine/mcp server'],
];

const lf = (text) => text.replaceAll('\r\n', '\n');
const read = (root, path) => lf(readFileSync(join(root, path), 'utf8'));
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** First `# heading` of a markdown text, else `fallback`. */
export function titleOf(text, fallback) {
  return /^#\s+(.+?)\s*$/m.exec(text)?.[1] ?? fallback;
}

/** First paragraph of prose after the title (headings, lists, tables and code skipped), on one line. */
export function summaryOf(text) {
  let inCode = false;
  const paragraph = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    if (!line.trim()) {
      if (paragraph.length) break;
      continue;
    }
    if (/^(#|\||[-*] |\d+\. |<|>|\[!)/.test(line)) {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(line.trim());
  }
  return paragraph
    .join(' ')
    .replace(/^Date: [\d-]+\.\s*/, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replaceAll('**', '');
}

/** A `# title` page's text with the sentence-case first line shortened to `max` characters at a word boundary. */
export function clip(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), max >> 1)).replace(/[,;:.\s]+$/, '') + '…';
}

/** Rows `| [name](link) | description |` of the markdown tables in examples/README.md. */
function exampleRows(text) {
  const rows = [];
  let section = '';
  for (const line of text.split('\n')) {
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) section = heading[1];
    const row = /^\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|(?:\s*`[^`]*`\s*\|)?\s*(.+?)\s*\|\s*$/.exec(line);
    if (row) rows.push({ section, name: row[1], link: row[2], description: row[3] });
  }
  return rows;
}

/**
 * Everything the AI tools read, from a repository checkout.
 * @returns {{
 *   packages: {id: string, name: string, description: string, category: string, readme: string,
 *              entries: {specifier: string, subpath: string, report: string}[]}[],
 *   docs: {path: string, title: string, summary: string, text: string}[],
 *   examples: {id: string, title: string, path: string, description: string, section: string}[],
 *   readme: string,
 * }}
 */
export function collectCorpus(root = resolve(import.meta.dirname, '..', '..')) {
  const catalog = existsSync(join(root, 'docs/catalog.json')) ? JSON.parse(read(root, 'docs/catalog.json')) : [];
  const catalogOrder = new Map(catalog.map((entry, index) => [entry.id, index]));
  const apiFiles = readdirSync(join(root, 'api')).filter((file) => file.endsWith('.api.md'));
  const packages = [];
  for (const id of readdirSync(join(root, 'packages')).sort(byText)) {
    const manifestPath = join(root, 'packages', id, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(read(root, `packages/${id}/package.json`));
    if (manifest.private) continue;
    const readmePath = `packages/${id}/README.md`,
      guidesPath = join(root, 'packages', id, 'docs'),
      // A package's guides (packages/<id>/docs/*.md, linked from its README) follow the README, so a section moved
      // out of a README stays in the package's llms page and in what the MCP server searches.
      guides = existsSync(guidesPath)
        ? readdirSync(guidesPath)
            .filter((file) => file.endsWith('.md'))
            .sort(byText)
            .map((file) => read(root, `packages/${id}/docs/${file}`).trim())
        : [],
      own = existsSync(join(root, readmePath)) ? read(root, readmePath) : '',
      readme = guides.length ? `${[own.trimEnd(), ...guides].filter(Boolean).join('\n\n')}\n` : own;
    const entries = [];
    for (const subpath of Object.keys(manifest.exports ?? {})) {
      const suffix = subpath === '.' ? '' : '.' + subpath.slice(2).replaceAll('/', '-'),
        file = `api/${id}${suffix}.api.md`;
      if (apiFiles.includes(`${id}${suffix}.api.md`))
        entries.push({ specifier: manifest.name + subpath.slice(1), subpath, report: read(root, file) });
    }
    const listed = catalog.find((entry) => entry.id === id);
    packages.push({
      id,
      name: manifest.name,
      description: (manifest.description ?? '').trim(),
      category: listed?.category ?? 'Other',
      readme,
      entries,
    });
  }
  packages.sort((a, b) => (catalogOrder.get(a.id) ?? 1e6) - (catalogOrder.get(b.id) ?? 1e6) || byText(a.id, b.id));
  // Every docs page except the working notes (HANDOFF, dated roadmaps and records) and the generated catalog pages.
  const skip = /(^|\/)(HANDOFF|README)\.md$|-20\d\d-\d\d-\d\d\.md$|roadmap\.md$|^docs\/whitepaper\//;
  let trackedDocs = null;
  try {
    trackedDocs = new Set(
      execFileSync('git', ['ls-files', '--', 'docs/**/*.md', 'docs/*.md'], { cwd: root, encoding: 'utf8' })
        .split(/\r?\n/)
        .filter(Boolean),
    );
  } catch {}
  const docPaths = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'whitepaper' && entry.name !== 'examples') walk(path);
      } else if (entry.name.endsWith('.md') && !skip.test(path) && (!trackedDocs || trackedDocs.has(path)))
        docPaths.push(path);
    }
  };
  walk('docs');
  const guideOrder = new Map(GUIDES.map(([path], index) => [path, index]));
  docPaths.sort((a, b) => (guideOrder.get(a) ?? 1e6) - (guideOrder.get(b) ?? 1e6) || byText(a, b));
  const docs = docPaths.map((path) => {
    const text = read(root, path);
    return { path, title: titleOf(text, path), summary: summaryOf(text), text };
  });
  const examples = [];
  if (existsSync(join(root, 'examples/README.md')))
    for (const row of exampleRows(read(root, 'examples/README.md')))
      examples.push({
        id: row.name.replace(/\/$/, '').replace(/\.html$/, ''),
        title: row.name,
        path: `examples/${row.link}`,
        description: row.description.replace(/\s*\(\[details\]\([^)]*\)\)/, ''),
        section: row.section,
      });
  return { packages, docs, examples, readme: read(root, 'README.md') };
}
