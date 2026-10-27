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
  // The blocker search's tap 0 sits on the receiver's own texel (radius 0); the filter's taps are spread from the centre.
  for (const [taps, scale, start] of [
    [16, 'search', 0],
    [32, 'radius', 0.5],
  ]) {
    assert.match(source, new RegExp(`for\\(var j=0u;j<${taps}u;j\\+\\+\\)\\{`));
    const step = start ? `(f32(j)+${start})` : 'f32(j)';
    assert.ok(
      source.includes(`let offset=direction*sqrt(${step}/${taps}.0)*${scale};direction=shadowGolden*direction;`),
      `${taps}-tap loop`,
    );
    let x = 1,
      y = 0;
    for (let j = 0; j < taps; j++) {
      const radius = Math.sqrt((j + start) / taps),
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
  assert.ok(
    source.includes(
      'let magic=vec2f(0.06711056,0.00583715);\n  return fract(52.9829189*fract(vec2f(dot(pixel,magic),dot(pixel.yx,magic))));',
    ),
  );
  assert.ok(source.includes('let noise=shadowNoise(position);'));
  assert.ok(source.includes('let angle=noise.x*6.2831853;let turn=vec2f(cos(angle),sin(angle));'));
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
    // noise.y (the transposed pixel) dithers cascades; it must not track the rotation angle (noise.x).
    const quadrants = [0, 0, 0, 0];
    let n = 0,
      sx = 0,
      sy = 0,
      sxy = 0,
      sxx = 0,
      syy = 0;
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const a = ign(ox + x, oy + y),
          b = ign(oy + y, ox + x);
        quadrants[(a < 0.5) * 2 + (b < 0.5)]++;
        n++;
        sx += a;
        sy += b;
        sxy += a * b;
        sxx += a * a;
        syy += b * b;
      }
    const r = (sxy / n - (sx / n) * (sy / n)) / Math.sqrt((sxx / n - (sx / n) ** 2) * (syy / n - (sy / n) ** 2));
    assert.ok(Math.abs(r) < 0.15 && Math.min(...quadrants) >= 52, `correlation ${r}, quadrants ${quadrants}`);
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

// Known bug (2026-10-27): the PCSS search reached the cascade's near plane, casterMargin (100) past the scene, so its 16
// reads landed far from any blocker and the receiver plane, carried that far, made surfaces behind the receiver count
// as blockers: speckled dark patches on lit faces of the animation guide's robot and a dotted ground-shadow edge.
// test/lit-faces-browser.mjs measures the pixels; these pin the shader text and the reduction that feeds it.
test('the PCSS search spans the distance to the nearest caster, reads the own texel first and ignores surfaces behind the receiver', () => {
  for (const anisotropic of [false, true]) {
    const source = shadowSampling(0, 'soft', anisotropic);
    assert.ok(source.includes(',settings:vec4f,nearest:vec4f}'), "the frame carries each layer's nearest depth");
    assert.ok(source.includes('max(reference-shadowFrame.nearest[layer],0.0)*shadowFrame.ranges[layer]'));
    assert.doesNotMatch(source, /settings\.x\*reference\*/, 'not the distance to the near plane');
    assert.ok(source.includes('sqrt(f32(j)/16.0)*search'), "tap 0 reads the receiver's own texel");
    assert.ok(source.includes('let plane=min(dot((vec2f(coord)+0.5)*texel-uv,slope),0.0);'));
    assert.ok(source.includes('if(d<reference+plane){sum+=d-plane;blockers+=1;}'));
    assert.ok(source.includes('reference+min(dot(offset,slope),0.0));}'), 'the filter taps compare the same way');
  }
  for (const filter of ['pcf', 'hard']) assert.doesNotMatch(shadowSampling(0, filter), /nearest\[/);
});

test('the soft filter reduces each layer to its nearest depth once the map changed and copies it into the frame', async () => {
  const gpu = mockGPU(),
    store = await TransformStore.create(4),
    engine = new Engine(
      { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
      store,
      { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 2, 6], target: [0, 0, 0] },
      null,
    ),
    view = context(gpu, { samples: 1, shader: 'let linear=direct*vec3f(1);' }),
    shadows = new Shadows({ resolution: 64, filter: 'pcf' });
  try {
    const setup = gpu.record(() => shadows.setup(engine)),
      uniform = setup.find((e) => e[0] === 'buffer' && e[2].size === 384 && e[2].usage === (64 | 8))?.[1],
      nearest = setup.find((e) => e[0] === 'buffer' && e[2].size === 16 && e[2].usage === (128 | 4 | 8))?.[1];
    assert.ok(uniform && nearest, 'a 384-byte frame uniform and a 16-byte nearest-depth buffer');
    const frame = (i) => {
      store.tick(false);
      view.begin(i);
      return gpu.record(() => passes(shadows)(view.c));
    };
    // The same frame index keeps the camera still, so only the filter changes between these frames.
    assert.ok(!frame(1).some((e) => e[0] === 'beginComputePass'), "'pcf' does not read the nearest depth");
    shadows.options.filter = 'soft';
    const log = frame(1),
      depth = log.findLastIndex((e) => e[0] === 'beginRenderPass'),
      compute = log.findIndex((e) => e[0] === 'beginComputePass'),
      seed = log.findIndex((e) => e[0] === 'writeBuffer' && e[1] === nearest),
      copy = log.findIndex((e) => e[0] === 'copyBufferToBuffer');
    assert.ok(compute >= 0 && compute > depth, 'a map drawn while the filter was pcf is reduced once it is soft');
    assert.equal(log[seed][3], '0000803f'.repeat(4), 'each layer starts at the cleared depth, 1.0');
    assert.deepEqual(
      log.slice(compute).find((e) => e[0] === 'pass.dispatchWorkgroups'),
      ['pass.dispatchWorkgroups', 2, 2, 4, undefined, undefined],
    );
    assert.deepEqual(log[copy], ['copyBufferToBuffer', nearest, 0, uniform, 368, 16]);
    const module = setup.concat(log).find((e) => e[0] === 'module' && e[2].code.includes('atomicMin(&nearest[id.z]'));
    assert.ok(module, 'the reduction shader');
    assert.ok(!frame(1).some((e) => e[0] === 'beginComputePass'), 'an unchanged map keeps its nearest depth');
    shadows.invalidate();
    const again = frame(1);
    assert.ok(
      again.findIndex((e) => e[0] === 'beginComputePass') > again.findLastIndex((e) => e[0] === 'beginRenderPass') &&
        again.some((e) => e[0] === 'beginRenderPass'),
      'a re-rendered map is reduced again, after its depth passes',
    );
  } finally {
    shadows.dispose();
    engine.dispose();
  }
});
