#!/usr/bin/env node
// Rebuilds web demos from their source: node scripts/web-demos/build.mjs <name> [name...] | --all
//
// Each demo folder holds the built page (index.html + assets/) and the source it came from (source/).
// This script bundles source/ against the engine packages in this checkout with Vite, writes a new
// index.html and assets/, removes the previous build's hashed chunks, and refreshes downloads/<name>.zip.
// Files in assets/ without a build hash (data the page fetches by name) are kept.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const demos = path.join(repo, 'demos');
const hashed = /-[A-Za-z0-9_-]{8}\.(?:js|css|wasm|png|jpe?g|webp|svg|woff2?|bin|glb|ktx2|hdr|json)$/;

const args = process.argv.slice(2);
const zip = !args.includes('--no-zip');
let names = args.filter((a) => !a.startsWith('--'));
if (args.includes('--all')) {
  names = fs.readdirSync(demos).filter((n) => fs.existsSync(path.join(demos, n, 'source')));
}
if (!names.length) {
  console.error('usage: node scripts/web-demos/build.mjs <demo> [demo...] | --all [--no-zip]');
  process.exitCode = 2;
}

/** The source module the built page started from: the one no other source module imports. */
function entryOf(dir) {
  const source = path.join(dir, 'source');
  const files = fs.readdirSync(source).filter((f) => /\.(?:m?js|ts)$/.test(f) && !/\.test\./.test(f));
  const imported = new Set();
  for (const f of files) {
    const text = fs.readFileSync(path.join(source, f), 'utf8');
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"]\.\/([^'"]+)['"]/g))
      imported.add(m[1].replace(/\?.*$/, ''));
  }
  const roots = files.filter((f) => !imported.has(f) && !imported.has(f.replace(/\.(?:m?js|ts)$/, '')));
  for (const preferred of ['scene.js', 'main.js', 'app.js', 'start.js', 'index.js'])
    if (roots.includes(preferred)) return preferred;
  if (roots.length === 1) return roots[0];
  throw new Error(`${path.basename(dir)}: cannot tell the entry module among ${roots.join(', ') || 'none'}`);
}

/** The page's HTML with the built script and stylesheet swapped for the source ones. */
function sourceHtml(dir, entry) {
  let html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  html = html.replace(/\s*<script type="module"[^>]*src="\.\/assets\/[^"]+"[^>]*><\/script>/g, '');
  html = html.replace(/\s*<link rel="modulepreload"[^>]*href="\.\/assets\/[^"]+"[^>]*>/g, '');
  html = html.replace(/\s*<link rel="stylesheet"[^>]*href="\.\/assets\/[^"]+"[^>]*>/g, '');
  const css = fs.existsSync(path.join(dir, 'source', 'style.css'))
    ? `\n  <link rel="stylesheet" href="../source/style.css">`
    : '';
  return html.replace('</head>', `  <script type="module" src="../source/${entry}"></script>${css}\n</head>`);
}

const failures = [];
for (const name of names) {
  const dir = path.join(demos, name);
  const work = path.join(dir, '.build');
  const out = path.join(dir, '.build-out');
  try {
    const entry = entryOf(dir);
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(work, 'index.html'), sourceHtml(dir, entry));
    await build({
      root: work,
      base: './',
      logLevel: 'warn',
      configFile: false,
      publicDir: false,
      resolve: {
        alias: [
          { find: 'margo-demo-status', replacement: path.join(here, 'demo-status.js') },
          { find: /^margo-boulder\/(.*)$/, replacement: path.join(repo, 'examples/boulder/$1.js') },
        ],
      },
      worker: { format: 'es' },
      build: {
        outDir: out,
        emptyOutDir: true,
        target: 'es2022',
        assetsDir: 'assets',
        chunkSizeWarningLimit: 100000,
        reportCompressedSize: false,
      },
    });
    const assets = path.join(dir, 'assets');
    fs.mkdirSync(assets, { recursive: true });
    for (const f of fs.readdirSync(assets)) if (hashed.test(f)) fs.rmSync(path.join(assets, f));
    for (const f of fs.readdirSync(path.join(out, 'assets')))
      fs.copyFileSync(path.join(out, 'assets', f), path.join(assets, f));
    fs.copyFileSync(path.join(out, 'index.html'), path.join(dir, 'index.html'));
    if (zip) {
      const target = path.join(demos, 'downloads', `${name}.zip`);
      fs.rmSync(target, { force: true });
      // The zip holds the folder's contents (index.html, assets/, source/ ...), as the gallery's downloads always have.
      // bsdtar writes zip with -a. Windows ships it as System32/tar.exe; elsewhere it is bsdtar.
      const tar =
        process.platform === 'win32'
          ? path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe')
          : 'bsdtar';
      const entries = fs.readdirSync(dir).filter((f) => f !== '.build' && f !== '.build-out');
      const r = spawnSync(tar, ['-a', '-c', '-f', target, ...entries], { cwd: dir, stdio: 'inherit' });
      if (r.status !== 0) throw new Error(`zip failed for ${name}`);
    }
    console.log(`built ${name} (entry source/${entry})`);
  } catch (error) {
    failures.push(name);
    console.error(`FAILED ${name}: ${error.message}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
}
if (failures.length) {
  console.error(`${failures.length} failed: ${failures.join(' ')}`);
  process.exitCode = 1;
}
