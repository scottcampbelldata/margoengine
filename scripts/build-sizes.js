// margoengine.com/sizes.html: core + stage and its 20,000 B limit on top, what a basic glTF scene fetches, every file
// loaded later and the call that loads it, then every package entry's raw (minified) and min+gzip bytes by catalog layer.
// Static HTML, no script (the site CSP allows only 'self' scripts). Inputs: docs/catalog.json (layers, order),
// examples/package-benchmarks/results/entry-sizes.json (entries, lazy files, the commit measured),
// results/basic-scene-network.json (scripts/basic-scene-network.mjs at the same commit), scripts/lazy-files.js (what
// loads when) and packages/*/package.json (peers). scripts/build-site.js writes it after a fresh measurement.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {LAZY_FILES} from './lazy-files.js';

const esc = text => String(text).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);
const bytes = n => n.toLocaleString('en-US');
const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const prose = text => esc(text).replace(/`([^`]+)`/g, '<code>$1</code>');

/** Reads the inputs from a checkout. */
export function readSizesInputs(root = resolve(import.meta.dirname, '..')) {
  const json = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  const catalog = json('docs/catalog.json'), sizes = json('examples/package-benchmarks/results/entry-sizes.json');
  const network = json('examples/package-benchmarks/results/basic-scene-network.json');
  const manifests = Object.fromEntries(catalog.map(entry => [entry.package, json(`packages/${entry.id}/package.json`)]));
  return {catalog, sizes, network, manifests};
}

const table = (id, caption, head, body) => `  <div class="table-scroll" role="region" aria-labelledby="${id}" tabindex="0">
  <table>
  <caption class="sr-only">${caption}</caption>
  <thead><tr>${head.map(([label, num]) => `<th scope="col"${num ? ' class="num"' : ''}>${label}</th>`).join('')}</tr></thead>
${body}
  </table>
  </div>`;

function basicScene(network) {
  const {files, total, notFetched} = network, wasm = notFetched.filter(file => file.path.endsWith('.wasm'));
  const cells = file => `<td class="num">${bytes(file.transferred)}</td><td class="num">${bytes(file.raw)}</td><td class="num">${bytes(file.gzip)}</td><td class="num">${bytes(file.brotli)}</td>`;
  const rows = files.map(file => `<tr><th scope="row"><code>${esc(file.path)}</code></th>${cells(file)}<td>${esc(file.role)}</td></tr>`);
  rows.push(`<tr class="total"><th scope="row">Total, ${files.length} requests</th>${cells(total)}<td></td></tr>`);
  return `<section class="network" aria-labelledby="basic-scene">
  <h2 id="basic-scene">A basic glTF scene on the network</h2>
  <p class="section-lede">The five-line stage app (<code>createStage('#scene')</code>, then <code>app.load('./model.glb')</code> of a ${bytes(files.find(file => file.path.endsWith('.glb')).raw)} B cube), built for production with Vite and opened in ${esc(network.browser)}. The browser's network log held exactly these files. Transferred is what crossed the wire: the body as served (the preview server gzips JavaScript) plus response headers. Raw, gzip and brotli are the built files.</p>
${table('basic-scene', 'Every request of a basic glTF scene, in bytes', [['File'], ['Transferred (B)', 1], ['Raw (B)', 1], ['Gzip (B)', 1], ['Brotli (B)', 1], ['What it is']], `<tbody>\n${rows.join('\n')}\n</tbody>`)}
  <p>The same build also produced ${notFetched.length} files the page never requested, ${bytes(notFetched.reduce((sum, file) => sum + file.raw, 0))} B in all, among them ${wasm.map(file => `<code>${esc(file.path)}</code> (${bytes(file.raw)} B)`).join(', ') || 'no Wasm'}, the CAD worker and chunks and the sky, particle, effect, environment and shadow packs. They load only when the calls below ask for them. Reproduce with <code>node scripts/basic-scene-network.mjs</code>: it fails if the page fetches any other file.</p>
</section>`;
}

function lazyFiles(sizes) {
  const groups = [...new Set(LAZY_FILES.map(file => file.package))].map(name => {
    const members = LAZY_FILES.filter(file => file.package === name);
    // The package heads its group on a row of its own, so the table keeps six columns and fits a desktop page.
    const rows = members.map(file => {
      const {raw, gzip, brotli} = sizes.lazyFiles[file.file];
      return `<tr><th scope="row"><code>${esc(file.label)}</code></th><td>${esc(file.kind)}</td><td class="num">${bytes(raw)}</td><td class="num">${bytes(gzip)}</td><td class="num">${bytes(brotli)}</td><td>${prose(file.when)}</td></tr>`;
    });
    return `<tbody data-lazy-package="${esc(name)}">\n<tr class="group"><th scope="rowgroup" colspan="6"><code>${esc(name)}</code></th></tr>\n${rows.join('\n')}\n</tbody>`;
  });
  return `<section class="lazy" aria-labelledby="loaded-later">
  <h2 id="loaded-later">Loaded later, and what loads it</h2>
  <p class="section-lede">Every file a package fetches or compiles on its own after the entry you import: the stage's packs, workers and Wasm runtimes. Workers, glue scripts and <code>.wasm</code> files are measured as served, because your bundler copies them as they are. The stage's packs, the BVH module worker and the Rapier and Recast modules are bundled and minified like the entries below (the packs with core left out, since the stage already loaded it). Rapier and Recast inline their Wasm, so neither makes a separate <code>.wasm</code> request.</p>
${table('loaded-later', 'Files loaded after the entry, in bytes, with the call that loads each', [['File'], ['Kind'], ['Raw (B)', 1], ['Gzip (B)', 1], ['Brotli (B)', 1], ['Loads when']], groups.join('\n'))}
</section>`;
}

function peers(manifest) {
  const optional = name => manifest.peerDependenciesMeta?.[name]?.optional ? ' (optional)' : '';
  const list = Object.keys(manifest.peerDependencies ?? {}).map(name => `<code>${esc(name)}</code>${optional(name)}`);
  const installs = Object.keys(manifest.dependencies ?? {}).map(name => `<code>${esc(name)}</code>`);
  return [list.join(', ') || 'None', installs.length ? `Installs ${installs.join(', ')}` : ''].filter(Boolean).join('<br>');
}

function packageRows(entry, entries, manifest) {
  const rows = Object.entries(entries).map(([path, {raw, gzip}], i) => {
    const name = path === '.' ? 'root' : path.startsWith('dist/workers/') ? `${path} (worker)` : path;
    const head = i ? '' : `<th scope="rowgroup" rowspan="${Object.keys(entries).length}"><a href="./catalog/#${esc(entry.id)}">${esc(entry.package)}</a></th>`;
    const tail = i ? '' : `<td rowspan="${Object.keys(entries).length}">${peers(manifest)}</td>`;
    return `<tr>${head}<td><code>${esc(name)}</code></td><td class="num">${bytes(raw)}</td><td class="num">${bytes(gzip)}</td>${tail}</tr>`;
  });
  return `<tbody data-package="${esc(entry.package)}">\n${rows.join('\n')}\n</tbody>`;
}

/**
 * The page. Throws when a catalog package or lazy file has no measurement, or the network record comes from another
 * build, so the page never shows a number that the one measured build did not produce.
 */
export function sizesPage({catalog, sizes, network, manifests}) {
  const missing = catalog.filter(entry => !Object.keys(sizes.packages[entry.package] ?? {}).length).map(entry => entry.package);
  if (missing.length) throw new Error(`entry-sizes.json has no sizes for ${missing.join(', ')}: run node examples/package-benchmarks/entry-sizes.mjs`);
  const unmeasured = LAZY_FILES.filter(file => !sizes.lazyFiles?.[file.file]).map(file => file.file);
  if (unmeasured.length) throw new Error(`entry-sizes.json has no sizes for ${unmeasured.join(', ')}: run node examples/package-benchmarks/entry-sizes.mjs`);
  const build = record => `${record.commit}${record.dirty ? ' (dirty)' : ''}`;
  if (build(network) !== build(sizes)) throw new Error(`basic-scene-network.json measured ${build(network)}, entry-sizes.json ${build(sizes)}: run node scripts/basic-scene-network.mjs`);
  const layers = [...new Set(catalog.map(entry => entry.category))];
  const {raw, gzip, limit} = sizes.coreStage, measured = `<code>${esc(sizes.commit)}</code>${sizes.dirty ? ' plus uncommitted changes in <code>packages/</code>' : ''}`;
  const sections = layers.map(layer => {
    const id = `layer-${slug(layer)}`, members = catalog.filter(entry => entry.category === layer);
    return `<section class="layer" aria-labelledby="${id}">
  <h2 id="${id}">${esc(layer)}</h2>
${table(id, `${esc(layer)}: bytes per package entry`, [['Package'], ['Entry'], ['Raw (B)', 1], ['Min+gzip (B)', 1], ['Peers on']],
    members.map(entry => packageRows(entry, sizes.packages[entry.package], manifests[entry.package])).join('\n'))}
</section>`;
  });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Package sizes · Margo Engine</title>
  <meta name="description" content="Raw and min+gzip bytes of every Margo Engine package entry, measured from one build, grouped by layer.">
  <link rel="canonical" href="https://margoengine.com/sizes.html">
  <meta name="theme-color" content="#0b1020">
  <link rel="icon" href="./favicon.ico" sizes="32x32">
  <link rel="stylesheet" href="./site.css">
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <header class="nav">
    <a class="brand" href="./" translate="no">Margo Engine</a>
    <nav aria-label="Primary">
      <a href="./#start">Get started</a>
      <a href="./sizes.html" aria-current="page">Sizes</a>
      <a href="./catalog/">Catalog</a>
      <a href="https://github.com/scottcampbelldata/margoengine">GitHub</a>
    </nav>
  </header>

  <main id="main" class="sizes">
    <section class="sizes-intro">
      <h1>Package sizes</h1>
      <p class="section-lede">Every number on this page was measured from the build of commit ${measured}, when this page was generated. Raw is minified ES2022 code; min+gzip is the same code gzipped. Each entry is bundled on its own with other packages left external, because your app shares them. Workers and Wasm that load later are <a href="#loaded-later">listed with the call that loads each</a>.</p>
      <div class="budget">
        <h2 id="core-stage">Core + stage</h2>
        <p class="budget-figure"><strong>${bytes(gzip)} B</strong> min+gzip, limit ${bytes(limit)} B</p>
        <meter min="0" max="${limit}" value="${gzip}" aria-labelledby="core-stage">${bytes(gzip)} of ${bytes(limit)} bytes</meter>
        <p><code>margoengine</code> (<code>createStage</code>) with <code>@margoengine/core</code> bundled in: ${bytes(raw)} B raw. The build fails at ${bytes(limit)} B gzip or above. Reproduce with <code>npm run measure:size</code>; every entry below with <code>node examples/package-benchmarks/entry-sizes.mjs</code>.</p>
      </div>
      <nav class="layer-links" aria-label="On this page">
        <ul>
          <li><a href="#basic-scene">Basic glTF scene</a></li>
          <li><a href="#loaded-later">Loaded later</a></li>
${layers.map(layer => `          <li><a href="#layer-${slug(layer)}">${esc(layer)}</a></li>`).join('\n')}
        </ul>
      </nav>
    </section>

${basicScene(network)}

${lazyFiles(sizes)}

${sections.join('\n\n')}

    <section class="status">
      <p>Method: ${esc(sizes.method)}. Source: <a href="https://github.com/scottcampbelldata/margoengine/blob/main/examples/package-benchmarks/results/entry-sizes.json">entry-sizes.json</a>.</p>
    </section>
  </main>

  <footer>
    <p>Built with precision, named with love. For Margie.</p>
    <p><a href="https://github.com/scottcampbelldata/margoengine">Source on GitHub</a> <a href="https://github.com/scottcampbelldata/margoengine/blob/main/LICENSE">MIT license</a> <a href="./catalog/">Catalog</a></p>
  </footer>
</body>
</html>
`;
}
