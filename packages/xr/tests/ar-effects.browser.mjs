// KB-XR-AREFFECTS1: in an AR session the eye's alpha comes from the depth the scene wrote, so a post effect that
// captures the scene must put that depth back into the eye, at 1 sample and at 4. On WebGPU and on the WebGL2 layer,
// with a stand-in headset (packages/webgl2-compat/test/xr.html) and the engine route: every pixel inside the solid
// meshes and an opaque line (depthWrite) with no effect stays opaque under every effect, and empty space stays
// see-through. The shared scene-depth capture (acquireDepth) and StencilBuffer redirect the depth too.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const SIZE = 256;
const fixture = await readFile('packages/webgl2-compat/test/xr.html', 'utf8');
const replace = (s, from, to) => {
  assert.ok(s.includes(from), from);
  return s.replace(from, to);
};
let html = replace(
  fixture,
  'const options = {',
  `const query = new URLSearchParams(location.search);
  // StencilBuffer redirects only where core's depth has no stencil: the device of this case lacks the feature.
  if (query.get('effect') === 'stencil')
    for (const features of [globalThis.GPUSupportedFeatures?.prototype, Set.prototype].filter(Boolean)) {
      const has = features.has;
      features.has = function (name) {
        return name !== 'depth32float-stencil8' && has.call(this, name);
      };
    }
  const options = { antialias: query.get('samples') === '4',`,
);
html = replace(html, 'width: 6 }', 'width: 6, depthWrite: true }');
html = replace(
  html,
  'const xr = await XR.create(engine);',
  `const effect = query.get('effect');
  const from = async (path) => import('/packages/' + path + '.js');
  const attach = {
    none: async () => {},
    tonemap: async () => (await from('tonemap/dist/index')).Tonemap.attach(engine),
    dof: async () => (await from('dof/dist/index')).DOF.attach(engine),
    fxaa: async () => (await from('post/dist/fxaa')).FXAA.attach(engine),
    smaa: async () => (await from('post/dist/smaa')).SMAA.attach(engine),
    bloom: async () => (await from('post/dist/bloom')).Bloom.attach(engine),
    ssao: async () => (await from('post/dist/ssao')).SSAO.attach(engine),
    taa: async () => (await from('taa/dist/index')).TAA.attach(engine),
    depth: async () => (await from('shared/gpu')).acquireDepth(engine),
    stencil: async () => (await from('materials/dist/index')).StencilBuffer.attach(engine),
    stack: async () => {
      const [{ PostStack }, { Tonemap }, { FXAA }] = await Promise.all(
        ['post/dist/stack', 'tonemap/dist/index', 'post/dist/fxaa'].map(from),
      );
      PostStack.attach(engine, [new Tonemap(), new FXAA()]);
    },
  };
  await attach[effect]();
  window.samples = engine.renderTarget.samples;
  window.depthFormat = engine.renderTarget.depthFormat;
  const xr = await XR.create(engine);`,
);
html = replace(html, "requestSession('immersive-vr')", "requestSession('immersive-ar')");
// `depth` is the shared scene-depth capture of water, html and contact lights; `stencil` the StencilBuffer.
const effects = ['tonemap', 'dof', 'fxaa', 'smaa', 'bloom', 'ssao', 'taa', 'stack', 'depth', 'stencil'];

/** The pixels whose whole `radius` neighbourhood has alpha `value`. */
function inside(eye, value, radius) {
  const out = [];
  for (let y = radius; y < SIZE - radius; y++)
    for (let x = radius; x < SIZE - radius; x++) {
      let all = true;
      for (let j = -radius; all && j <= radius; j++)
        for (let i = -radius; all && i <= radius; i++) all = eye[((y + j) * SIZE + x + i) * 4 + 3] === value;
      if (all) out.push((y * SIZE + x) * 4 + 3);
    }
  return out;
}

const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 'free', compat: false });
const origin = new URL(browser.page.url()).origin;
const messages = [];
browser.page.on('console', (m) => {
  if (m.type() === 'error' || /validation|invalid/i.test(m.text())) messages.push(m.text());
});
const checks = [],
  failures = [],
  plain = {},
  edges = [];
try {
  await browser.page.route('**/packages/webgl2-compat/test/xr.html*', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: html }),
  );
  const eyes = async (backend, samples, effect) => {
    const key = `${backend}/${samples}x/${effect}`;
    await browser.page.goto(
      `${origin}/packages/webgl2-compat/test/xr.html?mode=${backend}&route=engine&samples=${samples}&effect=${effect}`,
    );
    await browser.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const result = await browser.page.evaluate(() => ({
      ...window.check,
      samples: window.samples,
      depthFormat: window.depthFormat,
    }));
    assert.deepEqual(result.errors, [], key);
    assert.equal(result.gl, 0, key);
    assert.equal(result.samples, samples, key);
    if (effect === 'stencil') assert.equal(result.depthFormat, 'depth32float', key);
    return result.eyes.map((eye) => Buffer.from(eye, 'base64'));
  };
  for (const backend of ['native', 'compat'])
    for (const samples of [1, 4]) {
      const base = await eyes(backend, samples, 'none');
      plain[`${backend}/${samples}`] = base;
      for (const effect of effects) {
        const drawn = await eyes(backend, samples, effect);
        for (let eye = 0; eye < 2; eye++) {
          const solid = inside(base[eye], 255, 1),
            empty = inside(base[eye], 0, 3);
          const check = {
            backend,
            samples,
            effect,
            eye,
            solid: solid.length,
            seeThrough: solid.filter((i) => drawn[eye][i] !== 255).length,
            empty: empty.length,
            opaqueEmpty: empty.filter((i) => drawn[eye][i] === 255).length,
          };
          checks.push(check);
          if (check.solid < 3000 || check.empty < 20000 || check.seeThrough || check.opaqueEmpty) failures.push(check);
        }
      }
    }
  // KB-XR-AR4XCOMPAT1: with no effect the layer's eyes, edge alpha included, match WebGPU's (within rounding).
  for (const samples of [1, 4])
    for (let eye = 0; eye < 2; eye++) {
      const [native, compat] = ['native', 'compat'].map((backend) => plain[`${backend}/${samples}`][eye]);
      const edge = { samples, eye, partial: 0, differing: 0, largest: 0 };
      for (let i = 0; i < native.length; i++) {
        const delta = Math.abs(native[i] - compat[i]);
        if (delta > 2) edge.differing++;
        edge.largest = Math.max(edge.largest, delta);
        if (i % 4 === 3 && native[i] > 0 && native[i] < 255) edge.partial++;
      }
      edges.push(edge);
    }
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/xr-ar-effects-browser.json', JSON.stringify({ checks, edges }, null, 2));
  console.log('XR AR eyes, WebGL2 layer against WebGPU', JSON.stringify(edges));
  assert.ok(
    edges.every((edge) => edge.samples === 1 || edge.partial > 300),
    'the 4-sample eyes have antialiased edges',
  );
  assert.deepEqual(
    edges.filter((edge) => edge.differing),
    [],
    'the layer matches WebGPU within 2 of 255',
  );
  assert.deepEqual(failures, [], 'solid pixels stay opaque and empty pixels see-through under every effect');
  assert.deepEqual(messages, [], 'no page or GPU errors');
  console.log('XR AR effects PASS', checks.length, 'eye checks');
} finally {
  await browser.close();
}
