// Launch gate 4: a basic glTF scene fetches only what it needs. tests/fixtures/basic-scene is the README's stage app
// (`createStage('#scene')`, then `app.load('./model.glb')`), built for production by Vite like any app: the build
// output also holds the CAD chunk, the CAD worker and the 7.6 MB OCCT .wasm, the sky, particle, effect, environment
// and shadow packs. In a real browser (Playwright's network log) the page must fetch exactly its HTML, the entry
// chunk and its static imports, the @margoengine/gltf chunk and the model: no Wasm, no worker, no other pack.
// Records every request and the bytes transferred to examples/package-benchmarks/results/basic-scene-network.json,
// which margoengine.com/sizes.html lists (`npm run build:site` runs this). Needs WebGPU, so after build:packages:
//   node scripts/gpu-lock.mjs run --owner=<id> -- node scripts/basic-scene-network.mjs
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {brotliCompressSync, gzipSync} from 'node:zlib';
import {chromium} from '@playwright/test';
import {build, preview} from 'vite';

const root = resolve(import.meta.dirname, '..'), fixture = resolve(root, 'tests/fixtures/basic-scene');
const out = resolve(root, 'test-results/basic-scene'), port = 5241;

// A unit cube GLB (24 vertices with face normals, 36 indices), the smallest model that exercises the glTF path.
function cubeGLB() {
  const positions = [], normals = [], indices = [];
  for (const [axis, sign] of [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]]) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3, base = positions.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = [0, 0, 0], n = [0, 0, 0]; p[axis] = sign * 0.5; p[u] = a * 0.5 * sign; p[v] = b * 0.5; n[axis] = sign;
      positions.push(...p); normals.push(...n);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const bin = Buffer.concat([Buffer.from(new Float32Array(positions).buffer), Buffer.from(new Float32Array(normals).buffer), Buffer.from(new Uint32Array(indices).buffer)]);
  const json = Buffer.from(JSON.stringify({asset: {version: '2.0'}, buffers: [{byteLength: bin.length}],
    bufferViews: [{buffer: 0, byteLength: 288}, {buffer: 0, byteOffset: 288, byteLength: 288}, {buffer: 0, byteOffset: 576, byteLength: 144}],
    accessors: [{bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5]}, {bufferView: 1, componentType: 5126, count: 24, type: 'VEC3'}, {bufferView: 2, componentType: 5125, count: 36, type: 'SCALAR'}],
    meshes: [{primitives: [{attributes: {POSITION: 0, NORMAL: 1}, indices: 2}]}], nodes: [{mesh: 0}], scenes: [{nodes: [0]}], scene: 0}));
  const pad = (data, fill) => Buffer.concat([data, Buffer.alloc((4 - data.length % 4) % 4, fill)]);
  const chunk = (data, type) => {const header = Buffer.alloc(8); header.writeUInt32LE(data.length, 0); header.writeUInt32LE(type, 4); return Buffer.concat([header, data]);};
  const body = Buffer.concat([chunk(pad(json, 0x20), 0x4e4f534a), chunk(pad(bin, 0), 0x004e4942)]), header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([header, body]);
}

await build({configFile: false, root: fixture, base: './', publicDir: false, logLevel: 'warn',
  build: {outDir: out, emptyOutDir: true, target: 'es2022', manifest: true}});
await writeFile(join(out, 'model.glb'), cubeGLB());

// Expected: the HTML, the entry chunk and its static imports, the @margoengine/gltf chunk (and its static imports), the model.
const manifest = JSON.parse(readFileSync(join(out, '.vite/manifest.json'), 'utf8'));
const withImports = key => [manifest[key].file, ...(manifest[key].imports ?? []).flatMap(withImports)];
const gltfKey = Object.keys(manifest).find(key => /packages\/gltf\/dist\/index\.js$/.test(key));
assert.ok(gltfKey, 'the build has an @margoengine/gltf chunk');
const [entry, ...entryImports] = withImports('index.html'), [gltf, ...gltfImports] = withImports(gltfKey);
const roles = new Map([['index.html', 'Page'], ...entryImports.map(file => [file, 'Shared chunk']), ...gltfImports.map(file => [file, 'Shared chunk']),
  [entry, 'Entry: core + stage + app'], [gltf, '@margoengine/gltf (app.load)'], ['model.glb', 'Model']]);
const expected = new Set(roles.keys());
const built = readdirSync(out, {recursive: true}).map(file => file.replaceAll('\\', '/')).filter(file => !file.startsWith('.vite') && statSync(join(out, file)).isFile());
assert.ok(built.some(file => /occt-import-js.*\.wasm$/.test(file)), 'the build output holds the OCCT .wasm (so not fetching it is a real check)');

const server = await preview({configFile: false, root: fixture, logLevel: 'warn', build: {outDir: out}, preview: {host: '127.0.0.1', port, strictPort: true}});
const browser = await chromium.launch({channel: process.env.BROWSER_CHANNEL ?? 'msedge', headless: true});
try {
  const context = await browser.newContext({viewport: {width: 800, height: 600}}), page = await context.newPage(), requests = [], errors = [];
  context.on('requestfinished', async request => {
    const sizes = await request.sizes(), response = await request.response();
    requests.push({url: request.url(), status: response?.status() ?? 0, encoding: (await response?.headerValue('content-encoding')) ?? 'identity', body: sizes.responseBodySize, headers: sizes.responseHeadersSize});
  });
  context.on('requestfailed', request => errors.push(`request failed: ${request.url()} ${request.failure()?.errorText}`));
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
  await page.goto(`http://127.0.0.1:${port}/`);
  const scene = await page.waitForFunction(() => window.basicScene).then(handle => handle.jsonValue());
  assert.equal(scene.error, undefined, scene.error);
  assert.ok(scene.meshes > 0, 'the model loaded');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000); // a second of rendering: anything fetched late (a worker, a decoder) shows up too
  const adapter = await page.evaluate(async () => {const info = (await navigator.gpu?.requestAdapter())?.info; return info ? `${info.vendor} ${info.architecture} ${info.description}`.trim() : null;});
  await context.close();

  const path = url => {const {pathname} = new URL(url); return pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));};
  const fetched = requests.map(request => request.url.startsWith('data:') ? null : {...request, path: path(request.url)}).filter(Boolean);
  for (const {path, status} of fetched) assert.equal(status, 200, `${path} answered ${status}`);
  assert.deepEqual(errors, []);
  assert.deepEqual(fetched.map(file => file.path).filter(file => /\.wasm$|occt|draco|basis|rapier|recast|ifc|worker|cad/i.test(file)), [], 'no Wasm, worker or CAD file');
  assert.deepEqual([...new Set(fetched.map(file => file.path))].sort(), [...expected].sort(), 'exactly the HTML, entry chunk, glTF chunk and model');
  assert.equal(fetched.length, expected.size, 'each file once');

  const files = fetched.map(({path, encoding, body, headers}) => {
    const bytes = readFileSync(join(out, path));
    return {path, role: roles.get(path), encoding, transferred: body + headers, raw: bytes.length, gzip: gzipSync(bytes).length, brotli: brotliCompressSync(bytes).length};
  });
  const sum = key => files.reduce((total, file) => total + file[key], 0);
  const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim();
  const result = {
    commit: git('rev-parse', '--short', 'HEAD'), dirty: git('status', '--porcelain', '--', 'packages') !== '',
    browser: `${process.env.BROWSER_CHANNEL ?? 'msedge'} ${browser.version()} headless`, adapter,
    method: 'Vite production build of tests/fixtures/basic-scene (base ./, es2022), served by vite preview (its own on-the-fly gzip); transferred = Playwright requestfinished sizes (encoded body + response headers); raw, gzip and brotli of the same built files at zlib defaults',
    files, total: {requests: files.length, transferred: sum('transferred'), raw: sum('raw'), gzip: sum('gzip'), brotli: sum('brotli')},
    notFetched: built.filter(file => !expected.has(file)).map(file => ({path: file, raw: statSync(join(out, file)).size})),
  };
  await writeFile(resolve(root, 'examples/package-benchmarks/results/basic-scene-network.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  console.log(`basic scene: ${files.length} requests, ${result.total.transferred} B transferred; ${result.notFetched.length} built files not fetched`);
} finally {
  await browser.close();
  await new Promise(done => server.httpServer.close(done));
}
