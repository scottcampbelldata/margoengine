// Eager JavaScript per demo: the entry chunk plus everything it imports statically, gzip per chunk as served.
// Lazy chunks (dynamic import) are reported separately. Run `npm run build:packages` first.
// Usage: node scripts/measure-demo-bytes.js [--json=path]
import {build} from 'vite';
import {gzipSync} from 'node:zlib';
import {resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';

const quiet = {logLevel: 'silent', build: {write: false, target: 'es2022'}};
const demos = {
  'night-citadel': {root: 'apps/showcase-night-citadel'},
  afterlight: {root: 'examples/gameplay-sandbox'},
  meadow: {configFile: false, root: 'examples', publicDir: false, build: {rollupOptions: {input: resolve('examples/windy-meadow.html')}}},
  earth: {configFile: false, root: 'packages/creative/examples/earth'},
  // What `await stage.sky()` fetches on top of core + stage.
  'stage-sky': {configFile: false, publicDir: false, build: {lib: {entry: resolve('scripts/support/stage-sky-entry.js'), formats: ['es']}, rollupOptions: {external: [/^@margoengine\/core/]}}},
};

async function measure(config) {
  const result = await build({...quiet, ...config, build: {...quiet.build, minify: true, ...config.build}});
  const chunks = (Array.isArray(result) ? result[0] : result).output.filter(item => item.type === 'chunk');
  const byName = new Map(chunks.map(chunk => [chunk.fileName, chunk]));
  const eager = new Set();
  // Externals (core, for the stage sky path) appear in imports but are not chunks.
  const visit = name => {if (eager.has(name) || !byName.has(name)) return; eager.add(name); for (const next of byName.get(name).imports) visit(next);};
  for (const chunk of chunks) if (chunk.isEntry) visit(chunk.fileName);
  const size = list => list.reduce((sum, chunk) => sum + gzipSync(chunk.code).length, 0);
  return {eagerGzip: size(chunks.filter(c => eager.has(c.fileName))), lazyGzip: size(chunks.filter(c => !eager.has(c.fileName)))};
}

const results = {};
for (const [name, config] of Object.entries(demos)) results[name] = await measure(config);
console.log(JSON.stringify(results, null, 2));
const out = process.argv.find(arg => arg.startsWith('--json='));
if (out) await writeFile(out.slice(7), JSON.stringify(results, null, 2) + '\n');
