// margoengine.com/sizes.html: every package entry's raw (minified) and min+gzip bytes, grouped by catalog layer, with
// core + stage and its 20,000 B limit on top. Static HTML, no script (the site CSP allows only 'self' scripts).
// Inputs: docs/catalog.json (layers, order), examples/package-benchmarks/results/entry-sizes.json (every number and the
// commit measured) and packages/*/package.json (peers). scripts/build-site.js writes it after a fresh measurement.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const esc = text => String(text).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);
const bytes = n => n.toLocaleString('en-US');
const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/** Reads the three inputs from a checkout. */
export function readSizesInputs(root = resolve(import.meta.dirname, '..')) {
  const json = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  const catalog = json('docs/catalog.json'), sizes = json('examples/package-benchmarks/results/entry-sizes.json');
  const manifests = Object.fromEntries(catalog.map(entry => [entry.package, json(`packages/${entry.id}/package.json`)]));
  return {catalog, sizes, manifests};
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

/** The page. Throws when a catalog package has no measured entry, so the page never lists a package without a number. */
export function sizesPage({catalog, sizes, manifests}) {
  const missing = catalog.filter(entry => !Object.keys(sizes.packages[entry.package] ?? {}).length).map(entry => entry.package);
  if (missing.length) throw new Error(`entry-sizes.json has no sizes for ${missing.join(', ')}: run node examples/package-benchmarks/entry-sizes.mjs`);
  const layers = [...new Set(catalog.map(entry => entry.category))];
  const {raw, gzip, limit} = sizes.coreStage, measured = `<code>${esc(sizes.commit)}</code>${sizes.dirty ? ' plus uncommitted changes in <code>packages/</code>' : ''}`;
  const sections = layers.map(layer => {
    const id = `layer-${slug(layer)}`, members = catalog.filter(entry => entry.category === layer);
    return `<section class="layer" aria-labelledby="${id}">
  <h2 id="${id}">${esc(layer)}</h2>
  <div class="table-scroll" role="region" aria-labelledby="${id}" tabindex="0">
  <table>
  <caption class="sr-only">${esc(layer)}: bytes per package entry</caption>
  <thead><tr><th scope="col">Package</th><th scope="col">Entry</th><th scope="col" class="num">Raw (B)</th><th scope="col" class="num">Min+gzip (B)</th><th scope="col">Peers on</th></tr></thead>
${members.map(entry => packageRows(entry, sizes.packages[entry.package], manifests[entry.package])).join('\n')}
  </table>
  </div>
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
      <p class="section-lede">Every number on this page was measured from the build of commit ${measured}, when this page was generated. Raw is minified ES2022 code; min+gzip is the same code gzipped. Each entry is bundled on its own with other packages left external, because your app shares them.</p>
      <div class="budget">
        <h2 id="core-stage">Core + stage</h2>
        <p class="budget-figure"><strong>${bytes(gzip)} B</strong> min+gzip, limit ${bytes(limit)} B</p>
        <meter min="0" max="${limit}" value="${gzip}" aria-labelledby="core-stage">${bytes(gzip)} of ${bytes(limit)} bytes</meter>
        <p><code>margoengine</code> (<code>createStage</code>) with <code>@margoengine/core</code> bundled in: ${bytes(raw)} B raw. The build fails at ${bytes(limit)} B gzip or above. Reproduce with <code>npm run measure:size</code>; every entry below with <code>node examples/package-benchmarks/entry-sizes.mjs</code>.</p>
      </div>
      <nav class="layer-links" aria-label="Layers">
        <ul>
${layers.map(layer => `          <li><a href="#layer-${slug(layer)}">${esc(layer)}</a></li>`).join('\n')}
        </ul>
      </nav>
    </section>

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
