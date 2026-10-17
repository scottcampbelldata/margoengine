import test from 'node:test';
import assert from 'node:assert/strict';
import { shadowSampling } from '../src/shader.ts';
import { Shadows } from '../dist/index.js';
import { mockGPU, context, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';

const f32 = Math.fround,
  golden = 2.39996323;
// The shader's interleaved gradient noise (Jimenez 2014) of a pixel position, in Float32 steps.
const ign = (x, y) => {
  const inner = f32(f32(x * f32(0.06711056)) + f32(y * f32(0.00583715))),
    outer = f32(f32(52.9829189) * f32(inner - Math.floor(inner)));
  return outer - Math.floor(outer);
};

test('PCSS computes its golden-angle spiral in the loop: no constant tables, same radii and turn per tap', () => {
  const source = shadowSampling(0);
  assert.doesNotMatch(source, /array<vec2f|shadowDisk/, 'indexed constant tables become per-pixel arrays on phones');
  const [, c0, s0, s1, c1] = source.match(/const shadowGolden=mat2x2f\(([^,]+),([^,]+),([^,]+),([^)]+)\);/).map(Number);
  assert.equal(c0, c1);
  assert.equal(s0, -s1);
  assert.ok(Math.abs(c0 - Math.cos(golden)) < 1e-7 && Math.abs(s0 - Math.sin(golden)) < 1e-7, 'golden angle');
  const c = f32(c0),
    s = f32(s0);
  // Turning a unit vector by the column-major matrix, tap after tap, stays on the old spiral (angle j * golden).
  for (const [taps, scale] of [
    [16, 'search'],
    [32, 'radius'],
  ]) {
    assert.match(source, new RegExp(`for\\(var j=0u;j<${taps}u;j\\+\\+\\)\\{`));
    assert.ok(
      source.includes(`let offset=direction*sqrt((f32(j)+0.5)/${taps}.0)*${scale};direction=shadowGolden*direction;`),
      `${taps}-tap loop`,
    );
    let x = 1,
      y = 0;
    for (let j = 0; j < taps; j++) {
      const radius = Math.sqrt((j + 0.5) / taps),
        angle = j * golden;
      assert.ok(Math.abs(x * radius - Math.cos(angle) * radius) < 5e-6, `x at ${taps}/${j}`);
      assert.ok(Math.abs(y * radius - Math.sin(angle) * radius) < 5e-6, `y at ${taps}/${j}`);
      [x, y] = [f32(f32(c * x) + f32(-s * y)), f32(f32(s * x) + f32(c * y))];
    }
  }
  assert.match(source, /if\(blockers==0\)\{return 1;\}/);
  assert.match(source, /return visibility\/32\.0/);
});

test('each pixel turns the spiral by interleaved gradient noise of its screen position, with no time term', () => {
  const source = shadowSampling(0);
  assert.ok(
    source.includes(
      'let eye=shadowFrame.view*vec4f(position,1);let pixel=eye.xy/max(-eye.z,0.000001)*shadowFrame.settings.w;',
    ),
  );
  assert.ok(source.includes('return fract(52.9829189*fract(dot(pixel,vec2f(0.06711056,0.00583715))));'));
  assert.ok(source.includes('let angle=shadowNoise(position)*6.2831853;let turn=vec2f(cos(angle),sin(angle));'));
  assert.ok(
    source.includes('var blockers=0.0;var sum=0.0;var direction=turn;'),
    'the blocker search starts at the turn',
  );
  assert.ok(source.includes('var visibility=0.0;direction=turn;'), 'the filter restarts from the same turn');
  assert.doesNotMatch(source, /time|random/i, 'the same view renders the same pixels every frame');
  // Neighbouring pixels get well-spread angles: each 8 x 8 block uses every eighth of a turn about equally.
  for (const [ox, oy] of [
    [0, 0],
    [413, 97],
    [-37, -200],
  ]) {
    const bins = new Array(8).fill(0);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bins[Math.floor(ign(ox + x, oy + y) * 8)]++;
    assert.ok(Math.min(...bins) >= 6, `IGN spread ${bins}`);
  }
});

test('the frame uniform carries pixels per unit at view depth 1 for the noise (settings.w)', async () => {
  const gpu = mockGPU(),
    store = await TransformStore.create(4),
    engine = new Engine(
      { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
      store,
      { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 2, 6], target: [0, 0, 0] },
      null,
    ),
    view = context(gpu, { samples: 1, width: 200, height: 150, shader: 'let linear=direct*vec3f(1);' }),
    shadows = new Shadows({ resolution: 64 });
  try {
    shadows.setup(engine);
    store.tick(false);
    view.begin(0);
    view.camera.fov = 50;
    const log = gpu.record(() => passes(shadows)(view.c)),
      write = log.find((e) => e[0] === 'writeBuffer' && e[3].length === 368 * 2),
      values = new Float32Array(Uint8Array.from(Buffer.from(write[3], 'hex')).buffer);
    assert.equal(values[91], f32(150 / (2 * Math.tan((50 * Math.PI) / 360))));
  } finally {
    shadows.dispose();
    engine.dispose();
  }
});

test('PCSS keeps the core receiver patch, the gltf-pro direct hook and each requested bind group', () => {
  const shadows = new Shadows({ resolution: 64 }),
    groups = (output) =>
      [...output.matchAll(/@group\((\d+)\) @binding\((\d+)\)/g)].map((match) => [Number(match[1]), Number(match[2])]);
  try {
    for (const group of [0, 2]) {
      const output = shadows.shader('let linear=direct*vec3f(1);', group);
      assert.ok(output.includes('shadowLit(direct,i.position,i.normal)*'));
      assert.ok(output.includes(shadowSampling(group)));
      assert.deepEqual(
        groups(output),
        [
          [group, 1],
          [group, 2],
          [group, 3],
        ],
        'Tables must not add GPU uniforms or bindings',
      );
      assert.equal(shadows.shader('let linear=direct*vec3f(1);', group), output);
      const hooks = shadows.pbr(group);
      assert.equal(hooks.declarations, shadowSampling(group));
      assert.equal(hooks.direct('direct'), 'shadowLit(direct,i.position,s.n)');
      assert.deepEqual(groups(hooks.declarations), [
        [group, 1],
        [group, 2],
        [group, 3],
      ]);
      assert.equal(shadows.pbr(group), hooks, 'stable hooks');
      assert.match(
        shadows.shader('direct+ambient(s)', group),
        /shadowLit\(direct,i.position,s.n\)\+ambient\(s\)/,
        'retains the newest legacy PBR shader fallback',
      );
    }
  } finally {
    shadows.dispose();
  }
});

test('only an exactly zero direct-light vector bypasses visibility without changing its public shader signature', () => {
  const source = shadowSampling(0);
  assert.match(source, /fn shadowVisibility\(position:vec3f,normal:vec3f\)->f32/);
  assert.match(
    source,
    /if\(all\(direct==vec3f\(0\)\)\)\{return direct;\}return direct\*shadowVisibility\(position,normal\);/,
  );
  assert.doesNotMatch(source, /length\(direct\)|abs\(direct\)|epsilon/);
  const shadows = new Shadows({ resolution: 64 });
  try {
    assert.throws(() => shadows.shader('direct+emissive'), /standard PBR lighting shader/);
  } finally {
    shadows.dispose();
  }
});
