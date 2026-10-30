// Milestone M6 in Node: the packages' WebGL2 routes (their lazily loaded compat chunks, found in each package's dist)
// take the tier they were written for, and compute what their WebGPU route computes. The browser check
// (routes-browser.mjs) draws each one natively and on the layer and compares the pixels.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { planCompute, runComputeOnCPU } from '../dist/compute.js';
import { COMPAT_VENDOR as layerVendor } from '../dist/device.js';
import { COMPAT_VENDOR, compatTier, loadCompatRoute } from '../../shared/compat.js';

const packages = fileURLToPath(new URL('../../', import.meta.url));
/**
 * The compat chunk the package's build split off for its `import('./compat.js')`: the one its root imports lazily (a
 * package with several entries may also get packages/shared/compat.js as a chunk of the same name stem).
 */
async function route(name) {
  const root = readFileSync(`${packages}${name}/dist/index.js`, 'utf8'),
    file = readdirSync(`${packages}${name}/dist`).find(
      (f) =>
        /^compat-[\w-]+\.js$/.test(f) &&
        new RegExp(`import\\(\\s*["'\`]\\./${f.replace('.', '\\.')}["'\`]\\s*\\)`).test(root),
    );
  assert.ok(file, `${name} builds its route into its own chunk`);
  return import(`../../${name}/dist/${file}`);
}

test('compatTier and loadCompatRoute: the layer by its vendor, nothing loaded on native WebGPU', async () => {
  assert.equal(COMPAT_VENDOR, layerVendor, 'shared and the layer agree on the vendor');
  assert.equal(compatTier({ adapterInfo: { vendor: COMPAT_VENDOR } }), 'webgl2');
  assert.equal(compatTier({ adapterInfo: { vendor: 'nvidia' } }), 'native');
  assert.equal(compatTier({}), 'native', 'a device without adapterInfo is native');
  assert.equal(compatTier(undefined), 'native');
  let loads = 0;
  const load = async () => ++loads;
  assert.equal(loadCompatRoute({ adapterInfo: { vendor: 'nvidia' } }, load), undefined);
  assert.equal(await loadCompatRoute({ adapterInfo: { vendor: COMPAT_VENDOR } }, load), 1);
  assert.equal(loads, 1);
});

test('DOF: the CoC, tile and bokeh kernels without workgroup memory run as fragment draws', async () => {
  const dof = await route('dof'),
    shaders = await import('../../dof/src/shaders.ts'),
    coc = dof.cocPixelShader(shaders),
    bokeh = dof.bokehAloneShader(shaders);
  for (const [name, source] of Object.entries({ coc, tiles: dof.tilesShader, bokeh }))
    assert.equal(planCompute({ source, entryPoint: 'main' }).tier, 'fragment', name);
  assert.doesNotMatch(coc + bokeh, /var<workgroup>|groupMax|workgroupBarrier/);
  assert.throws(() => dof.cocPixelShader({ ...shaders, cocShader: shaders.cocShader.replace('tiles', 'maxima') }), {
    code: 'unsupported',
    message: /DOF on WebGL2 needs the shader its compatibility route was written for/,
  });
});

test('splats: one CPU invocation sorts the projected keys in the order of the 8-pass GPU radix sort', async () => {
  const { cpuSort } = await route('splats');
  assert.equal(planCompute({ source: cpuSort, entryPoint: 'main' }).tier, 'cpu');
  // Keys as the projection writes them (inverted depth bits, splat index), with ties, culled splats (0xffffffff)
  // and every byte of the key in use.
  const n = 5000,
    keys = new Uint32Array(n * 2);
  let seed = 7;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let i = 0; i < n; i++) {
    const r = next();
    keys[i * 2] = r % 5 === 0 ? 0xffffffff : r % 7 === 0 ? 0x80000000 : r;
    keys[i * 2 + 1] = i;
  }
  // The GPU route: LSD radix sort on the key, 4 bits a pass, stable.
  const expected = [...Array(n).keys()]
    .map((i) => [keys[i * 2], keys[i * 2 + 1]])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .flat();
  const spare = new Uint32Array(n * 2);
  runComputeOnCPU({
    source: cpuSort,
    workgroups: [1],
    buffers: new Map([
      ['0:0', Uint32Array.of(n, 0, 0, 0)],
      ['0:1', keys],
      ['0:2', spare],
    ]),
  });
  assert.deepEqual([...keys], expected, 'sorted by key, ties in index order, in the keys buffer');
});

test('culling: the CPU route keeps exactly the parts the kernels keep, in order', async () => {
  const { cullParts, cullMeshes } = await route('culling');
  // Parts with a local sphere of radius 1 along x from -20 to 20; a frustum slab |x| <= 5.
  const count = 41,
    records = new Float32Array(count * 24);
  for (let i = 0; i < count; i++) {
    records.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, i - 20, 0, 0, 1], i * 24);
    records[i * 24 + 16] = i;
  }
  const planes = new Float32Array(24);
  planes.set([1, 0, 0, 5, -1, 0, 0, 5, 0, 1, 0, 1e3, 0, -1, 0, 1e3, 0, 0, 1, 1e3, 0, 0, -1, 1e3]);
  const hidden = new Uint32Array(count);
  hidden[20] = 1;
  const lists = {
    records,
    hidden,
    bounds: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1),
    batchOf: Uint32Array.from({ length: count }, (_, i) => +(i >= 30)),
    starts: [0, 30],
    count,
  };
  const drawn = new Float32Array(count * 24),
    args = new Uint32Array(10),
    kept = new Uint32Array(2);
  cullParts(lists, planes, true, drawn, args, kept);
  // Centres -6 to 6 touch the slab (radius 1); 0 (index 20) is hidden.
  const ids = (start, n) => Array.from({ length: n }, (_, k) => drawn[(start + k) * 24 + 16]);
  assert.deepEqual(ids(0, kept[0]), [14, 15, 16, 17, 18, 19, 21, 22, 23, 24, 25, 26]);
  assert.deepEqual([kept[1], args[1], args[6]], [0, 12, 0]);
  cullParts(lists, planes, false, drawn, args, kept);
  assert.deepEqual([args[1], args[6]], [29, 11], "'none' keeps every part that is not hidden");
  // CulledMeshes: same slab, a screen-size threshold off (0), one batch of core instance records.
  const frame = new Float32Array(44);
  frame.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  frame.set(planes, 16);
  const packed = new Float32Array(count * 24),
    n = cullMeshes(records, count, [0, 0, 0, 1], frame, packed);
  assert.deepEqual(
    Array.from({ length: n }, (_, k) => packed[k * 24 + 16]),
    [14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26],
  );
});
