// The WebGL2 layer's staged route (src/compat.ts, src/compat-staged.ts) on the CPU: the passes it draws for a sample,
// counted by program, light kind and part. On ANGLE Direct3D 11 each pass costs about 22 us whatever its area (12 of
// GPU, 12 of JavaScript), so a 480 x 300 reference at 16384 samples took about 555 s there against 14 s on WebGPU
// (KB-L5a-10, docs/known-bugs.md): 1,527 passes a sample, two parts (273 rows and 27) of 16 iterations of 47 passes.
// A light kind the frame switches off draws nothing, and a dispatch within 1.5 parts is one part; every value is the
// same (browser-check's `determinism` draws every kind and every iteration and compares bit for bit).
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { VoxelPathTracer } from '../dist/index.js';
import { fakeDevice, fakeEngine, settle, simpleScene } from './support.js';

// The stager is internal to the route's chunk: load its source (Node strips the types; `./x.js` imports are `x.ts`).
registerHooks({
  resolve: (specifier, context, next) => {
    if (/^\.\.?\/.*\.js$/.test(specifier) && context.parentURL?.endsWith('.ts'))
      if (existsSync(new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)))
        return next(specifier.replace(/\.js$/, '.ts'), context);
    // A JavaScript module (packages/shared) or a package.
    return next(specifier, context);
  },
});
const { partPlan } = await import('../src/compat.ts');
const { MAX_LIGHT_KINDS } = await import('../src/compat-staged.ts');

// A fake device of the WebGL2 layer that keeps every render pass: its label and the step slot (light kind and page)
// it binds. Census read-backs are zeros: every path has finished.
function harness() {
  const device = fakeDevice(),
    encoder = device.createCommandEncoder,
    passes = [];
  device.adapterInfo = { vendor: 'margo-webgl2', architecture: 'webgl2', device: 'test', description: 'test' };
  device.createCommandEncoder = (d) => {
    const e = encoder(d);
    e.beginRenderPass = (desc) => {
      const pass = { label: desc.label, step: undefined };
      passes.push(pass);
      return new Proxy(
        {},
        {
          get:
            (_, name) =>
            (...args) => {
              if (name === 'setBindGroup' && args[0] === 2) pass.step = args[2][0] / 256;
            },
        },
      );
    };
    e.resolveQuerySet = () => {};
    e.copyTextureToTexture = () => {};
    return e;
  };
  return { ...fakeEngine(device), passes };
}

const count = (passes, label) => passes.filter((p) => p.label === `voxel-pathtracer ${label}`).length;

// Renders 480 x 300 at 7 samples (one dispatch) twice and gives the passes of the second, the one on the horizon.
async function second(attach, options = {}) {
  const h = harness(),
    tracer = attach(h.engine, h.device);
  try {
    await tracer.ready;
    for (let i = 0; i < 4; i++) h.frame(), await settle();
    const image = { width: 480, height: 300, samples: 7, seed: 1, denoise: false, ...options };
    await tracer.renderImage(image);
    h.passes.length = 0;
    await tracer.renderImage(image);
    return h.passes.slice();
  } finally {
    tracer.dispose();
  }
}

test('a 480 x 300 sample is one part of the route, and parts stay within 1.5 times PART_PATHS', async () => {
  // Plans: one sample of 480 x 300 is one part; 1024 x 1024 is 8 bands of 128 rows; parts are even.
  const bytes = 2 * 7 * 112;
  assert.deepEqual(partPlan(480, 300, 1, bytes), { rows: 300, samples: 1 });
  assert.deepEqual(partPlan(480, 300, 7, bytes), { rows: 300, samples: 1 });
  assert.deepEqual(partPlan(1024, 1024, 1, bytes), { rows: 128, samples: 1 });
  assert.deepEqual(partPlan(96, 64, 16, bytes), { rows: 64, samples: 16 });
  for (const [w, r, n] of [
    [480, 300, 7],
    [1500, 1100, 4],
    [96, 64, 16],
    [4096, 3, 9],
    [7, 5, 3000],
    [3840, 2160, 1],
  ]) {
    const p = partPlan(w, r, n, bytes);
    assert.ok(w * p.rows * p.samples <= 1.5 * 2 ** 17, `${w} x ${r} x ${n}: ${JSON.stringify(p)}`);
    assert.ok(w * p.rows * p.samples * bytes <= 307e6, `${w} x ${r} x ${n}: state`);
    assert.ok(p.rows >= 1 && p.rows <= r && p.samples >= 1 && p.samples <= n);
  }
  // A part's state stays at most 307 MB whatever the pages a path holds.
  const p = partPlan(480, 300, 7, 2 * 9 * 112);
  assert.ok(480 * p.rows * p.samples * 2 * 9 * 112 <= 307e6);
  const passes = await second((e) => VoxelPathTracer.attach(e, { scene: simpleScene() }));
  assert.equal(count(passes, 'finish'), 7, 'one part a sample (two before: 273 rows, then 27)');
  assert.equal(count(passes, 'marks'), 7);
});

// The light kinds a pass draws (sample, shadow and gather passes, by their step slot: kind x pages + page).
const kindsOf = (passes, pages) =>
  [
    ...new Set(passes.filter((p) => /(sample|shadow|gather)$/.test(p.label)).map((p) => Math.floor(p.step / pages))),
  ].sort();
const sun = { skyColor: [0.6, 0.7, 1], sunIntensity: 2, sunDirection: [0.3, 0.8, 0.5] };

test('the route draws no pass for a light kind the frame switches off', async () => {
  const pages = 7,
    // Kinds: 0 the sun, 1 emitters, 2 area lights, 3 the environment map, 4 the shadow walk's candidates.
    cases = [
      // simpleScene: no sun, no emitters, no area lights, no environment map: only the walk's kind is drawn.
      [simpleScene(), [4], 16 * 27 + 11],
      [simpleScene({ environment: sun }), [0, 4], 16 * 32 + 11],
      // Uniform fog keeps distant lights out of reach.
      [simpleScene({ environment: { ...sun, fog: { density: 0.01 } } }), [4], 16 * 27 + 11],
      [simpleScene({ materials: [{ id: 1, color: [1, 1, 1], type: 'emit', emission: 2 }] }), [1, 4], 16 * 32 + 11],
    ];
  for (const [scene, kinds, perSample] of cases) {
    const passes = await second((e) => VoxelPathTracer.attach(e, { scene }));
    assert.deepEqual(kindsOf(passes, pages), kinds, JSON.stringify(scene.environment ?? scene.materials));
    // Passes a sample (16 iterations of one part, its start, finish, marks and two censuses): 1,527 before.
    assert.equal(passes.length / 7, perSample);
  }
  // The route's test switch draws every kind (browser-check `determinism` compares the two images bit for bit).
  const every = await second((e, device) => {
    device.voxelTraceEveryKind = true;
    return VoxelPathTracer.attach(e, { scene: simpleScene() });
  });
  assert.deepEqual(kindsOf(every, pages), [0, 1, 2, 3, 4]);
  assert.equal(every.length / 7, 16 * 47 + 11);
});

test('a light kind past every bound the mesh feature sets draws no pass', async () => {
  // Kinds 5 and 6 are the mesh feature's (src/mesh-light-shader.ts): its bound is 5, or 7 once the scene has a mesh
  // light header (src/mesh-light-build.ts). The route draws MAX_LIGHT_KINDS kinds for a bound that is not a literal.
  const { readFileSync } = await import('node:fs'),
    shader = readFileSync(new URL('../src/mesh-light-shader.ts', import.meta.url), 'utf8'),
    build = readFileSync(new URL('../src/mesh-light-build.ts', import.meta.url), 'utf8'),
    unset =
      /fn meshProposalCount\(\)->u32 \{let header=meshLights\(\);if\(header==0u\)\{return (\d+)u;\}return scene\[header\+4u\];\}/.exec(
        shader,
      ),
    set = [...build.matchAll(/lights\[lights\[12\]!\s*\+\s*4\]\s*=\s*(\d+);/g)];
  assert.ok(unset && set.length === 1, 'the mesh feature sets its bound in the two places this test reads');
  assert.ok(Number(unset[1]) <= MAX_LIGHT_KINDS && Number(set[0][1]) <= MAX_LIGHT_KINDS);
  assert.equal(
    MAX_LIGHT_KINDS,
    Number(set[0][1]),
    'no kind is drawn past the largest bound (8 drew kind 7 for nothing)',
  );
});
