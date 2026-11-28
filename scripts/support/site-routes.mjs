// The pages margoengine.com serves, as one list that scripts/build-site.js builds from and scripts/check-site-links.mjs
// checks links against. A page added to the site goes here (or into site/), so the build and the link check agree.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scientificPages } from './sciviz-site-pages.mjs';

/** Example pages built into /demos/<name>.html. */
export const demoPages = [
  'character-animation',
  'robot-expressive',
  'flight-helmet',
  'windy-meadow',
  'split-screen',
  'minimap',
  'hud-preview',
  'batched-mesh',
  'buoyancy',
  'floating',
  'character-controller',
  'cyprus-raft',
  'ocean',
  'water-ripples',
  'clipping-planes',
  'scene-targets',
  'depth-texture',
  'animation-formats',
  'texture-formats',
  'compute-lab',
  ...scientificPages,
  'ui-game',
  'weather',
  'dual-viewport',
];

/** Package example folders built into /demos/<name>/, from packages/<name>/examples. */
export const demoPackageFolders = ['dof', 'tonemap', 'animator'];

/** Example folders built into /demos/<name>/, from examples/<name>. */
export const demoExampleFolders = ['orrery', 'storm-light', 'molten-words', 'cathedral-light', 'biomes'];

/** Other folders under /demos/: the Earth demo (packages/creative/examples/earth) and Boulder (scripts/build-boulder.mjs). */
export const demoOtherFolders = ['earth', 'boulder'];

const SKIP = new Set(['dist', 'node_modules']);

function walk(dir, prefix, found) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`, found);
    else found.push(`${prefix}${entry.name}`);
  }
}

/**
 * Every file path (relative to the site root, forward slashes) that the built site serves, apart from the pages under
 * /llms/ (`sitePages` of scripts/build-llms.mjs). Folders built by Vite are listed by their entry page: the check
 * can say a page exists there, not which ids it has.
 * `source` maps a served path to the repository file whose text holds its ids (site/ files and the catalog's files).
 */
export function siteFiles(root) {
  const served = new Set(),
    source = new Map();
  const files = [];
  if (existsSync(join(root, 'site'))) walk(join(root, 'site'), '', files);
  for (const file of files) {
    served.add(file);
    source.set(file, `site/${file}`);
  }
  // docs/ is copied to /catalog/ without its Markdown (scripts/build-site.js).
  const docs = [];
  if (existsSync(join(root, 'docs'))) walk(join(root, 'docs'), '', docs);
  for (const file of docs.filter((name) => !name.endsWith('.md'))) {
    served.add(`catalog/${file}`);
    source.set(`catalog/${file}`, `docs/${file}`);
  }
  const built = [
    'gameplay-sandbox/index.html',
    'voxel/index.html',
    'bench/index.html',
    'bench/scenes/page.html',
    // Files scripts/build-site.js copies in beside the pages.
    'THIRD-PARTY-NOTICES.md',
    'bench/assets/ATTRIBUTION.md',
    'demos/assets/ATTRIBUTION.md',
    'demos/assets/robot-CREDITS.md',
    'demos/assets/sciviz/README.md',
    'demos/earth/assets/ATTRIBUTION.md',
    ...demoPages.map((name) => `demos/${name}.html`),
    ...[...demoPackageFolders, ...demoExampleFolders, ...demoOtherFolders].map((name) => `demos/${name}/index.html`),
  ];
  const galleryDir = join(root, 'examples/gallery');
  if (existsSync(galleryDir))
    for (const name of readdirSync(galleryDir)) if (name.endsWith('.html')) built.push(`gallery/${name}`);
  for (const file of built) served.add(file);
  return { served, source };
}

/** The rules of site/_redirects (Cloudflare Pages: "<from> <to> <status>" per line), with their line numbers. */
export function redirectRules(root) {
  const file = join(root, 'site/_redirects');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .flatMap((text, index) => {
      const [from, to] = text.trim().split(/\s+/);
      return from && !from.startsWith('#') ? [{ line: index + 1, from, to }] : [];
    });
}

/** True when `path` is a file in `served` (a Cloudflare Pages lookup: /x is x, x.html or x/index.html). */
export function resolveRoute(served, path) {
  const clean = path.replace(/^\/+/, '');
  if (clean === '' || clean.endsWith('/')) return served.has(`${clean}index.html`) ? `${clean}index.html` : null;
  for (const candidate of [clean, `${clean}.html`, `${clean}/index.html`]) if (served.has(candidate)) return candidate;
  return null;
}
