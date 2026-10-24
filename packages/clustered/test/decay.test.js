// Light parity (Crocotile point and spot lights): decay, angle + penumbra, unlimited range, and receivers without
// local-light shadows. The falloff is the one @margoengine/bvh's vertex-light bake uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Clustered, clusteredSampling } from '../dist/index.js';
import { cullingShader } from '../src/shader.ts';
import { bakeVertexColors } from '../../bvh/dist/bake.js';
import { wgsl } from '../../core/src/shaders.ts';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

// CPU mirror of the definition: window / max(d^decay, 0.01), window = range > 0 ? clamp(1 - (d/range)^4, 0, 1)^2 : 1,
// and the cone smoothstep(cos(angle), cos(angle * (1 - penumbra)), dot(-L, direction)), a step when the two are equal.
const attenuation = (d, range, decay = 2) =>
  (range > 0 ? Math.min(Math.max(1 - (d / range) ** 4, 0), 1) ** 2 : 1) / Math.max(d ** decay, 0.01);
const smoothstep = (low, high, x) => {
  if (x < low) return 0;
  if (x >= high) return 1;
  const t = (x - low) / (high - low);
  return t * t * (3 - 2 * t);
};
const cone = (angle, penumbra, cosine) => smoothstep(Math.cos(angle), Math.cos(angle * (1 - penumbra)), cosine);

function harness() {
  const h = optionalGPU();
  Object.assign(h.engine.gpu.limits, { maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 });
  h.frame = () => {
    h.context.shader = wgsl;
    h.context.bindings.length = 0;
    h.engine.frameGraph.execute(h.context);
  };
  return h;
}

test('falloff and cone: the bake numbers (decay 1 at 2 m is 0.5, decay 0 is the window alone, penumbra 0 a step)', () => {
  const close = (a, b) => Math.abs(a - b) < 1e-12;
  assert.ok(close(attenuation(2, 0, 1), 0.5));
  assert.ok(close(attenuation(2, 3, 0), (1 - (2 / 3) ** 4) ** 2));
  assert.ok(close(attenuation(2, 0), 0.25), 'default decay 2 is inverse-square');
  assert.ok(close(attenuation(0.05, 0), 100), 'max(d^decay, 0.01) caps the peak');
  assert.equal(attenuation(3, 3), 0, 'nothing at the range');
  const deg = Math.PI / 180;
  assert.equal(cone(30 * deg, 0, Math.cos(29.9 * deg)), 1);
  assert.equal(cone(30 * deg, 0, Math.cos(30 * deg)), 1, 'hard edge: on the edge is lit');
  assert.equal(cone(30 * deg, 0, Math.cos(30.1 * deg)), 0);
  assert.equal(cone(30 * deg, 0.5, Math.cos(15 * deg)), 1);
  // Inside the penumbra (15 to 30 degrees) the cone falls smoothly, in cosine.
  const fade = [17, 22.5, 28].map((a) => cone(30 * deg, 0.5, Math.cos(a * deg)));
  assert.ok(fade[0] < 1 && fade[0] > fade[1] && fade[1] > fade[2] && fade[2] > 0, `penumbra ${fade}`);
});

test('setLights packs decay, angle and penumbra; lights without them keep the exact old record and shader', () => {
  const h = harness(),
    legacy = [
      { position: [0, 2, 1], range: 5 },
      { position: [1, 2, 1], range: 5, direction: [0, -1, 0], outerAngle: 0.6, innerAngle: 0.3 },
    ],
    lights = new Clustered({ grid: [2, 2, 2] }).setLights(legacy),
    plain = new Clustered({ grid: [2, 2, 2] }).setLights(legacy);
  h.engine.use(lights);
  try {
    h.frame();
    const original = h.context.shader,
      before = lights['data'].slice(0, 32);
    assert.deepEqual(before, plain['data'].slice(0, 32));
    assert.equal(before[13], 0, 'point');
    assert.equal(before[16 + 13], 1, 'spot');
    lights.setLights([
      ...legacy,
      { position: [0, 3, 0], range: 0, decay: 1 },
      { position: [0, 3, 0], range: 8, direction: [0, -2, 0], angle: 0.5, penumbra: 0.25, decay: 0 },
      { position: [0, 3, 0], range: 8, direction: [0, -1, 0], angle: 0.5 },
    ]);
    const data = lights['data'];
    assert.deepEqual(data.slice(0, 32), before, 'old-style lights are packed exactly as before');
    assert.equal(data[32 + 3], Infinity, 'range 0 is unlimited');
    assert.equal(data[32 + 13], -2, 'point with decay 1: -(1 + decay)');
    assert.deepEqual(
      [...data.slice(48 + 8, 48 + 14)],
      [0, -1, 0, Math.cos(0.5), Math.cos(0.375), 2].map(Math.fround),
      'spot: unit direction, cos(angle), cos(angle * (1 - penumbra)), 2 + decay 0',
    );
    assert.equal(data[64 + 13], 4, 'spot with the default decay 2: 2 + decay');
    assert.equal(data[64 + 11], data[64 + 12], 'penumbra 0: outer and inner cosines are equal (a hard edge)');
    h.frame();
    assert.notEqual(h.context.shader, original);
    assert.ok(h.context.shader.includes('let legacy=kind==0.0||kind==1.0;'));
    assert.ok(lights.pbr(2).declarations.includes('max(pow(max(distance,0.0001),decay),0.01)'));
    assert.equal(lights.pbr(2).declarations, clusteredSampling(2, undefined, undefined, false, true));
    lights.setLights(legacy);
    h.frame();
    assert.equal(h.context.shader, original, 'without decay or angle lights the shader is the original again');
    assert.equal(lights.pbr(2).declarations, clusteredSampling(2));
  } finally {
    lights.dispose();
    plain.dispose();
  }
});

test('setLights validates decay, the angle/penumbra cone and unlimited ranges before changing anything', () => {
  const lights = new Clustered({ grid: [2, 2, 2] }),
    spot = { position: [0, 2, 0], range: 5, direction: [0, -1, 0] };
  lights.setLights([{ position: [0, 1, 0], range: 2 }]);
  const before = lights['data'].slice(0, 16);
  for (const [light, type] of [
    [{ position: [0, 1, 0], range: 2, decay: -1 }, RangeError],
    [{ position: [0, 1, 0], range: 2, decay: Number.NaN }, RangeError],
    [{ position: [0, 1, 0], range: -1 }, RangeError],
    [{ position: [0, 1, 0], range: 0, castShadow: true }, RangeError],
    [{ ...spot, angle: 0.5, outerAngle: 0.5 }, TypeError],
    [{ ...spot, outerAngle: 0.5, penumbra: 0.5 }, TypeError],
    [{ ...spot, angle: Math.PI / 2 + 1e-9 }, RangeError],
    [{ ...spot, outerAngle: Math.PI / 2 + 1e-9 }, RangeError],
    [{ ...spot, angle: 0 }, RangeError],
    [{ ...spot, angle: 0.5, penumbra: 1.5 }, RangeError],
    [{ ...spot, direction: [0, 0, 0], angle: 0.5 }, RangeError],
    [{ ...spot }, RangeError],
  ])
    assert.throws(() => lights.setLights([{ position: [9, 9, 9], range: 1 }, light]), type, JSON.stringify(light));
  assert.deepEqual(lights['data'].slice(0, 16), before);
  assert.equal(lights['lightCount'], 1);
  lights.dispose();
});

test('add(receiver, {receiveShadow: false}) lights it without local-light shadow terms or bindings', () => {
  const h = harness(),
    lights = new Clustered({ grid: [2, 2, 2], shadows: { maxLights: 1 } }),
    handed = [],
    receiver = () => ({
      addLighting(effect) {
        handed.push(effect);
        return () => handed.push('removed');
      },
    });
  lights.setLights([{ position: [0, 2, 1], range: 6, shadow: true }]);
  h.engine.use(lights);
  try {
    const remove = lights.add(receiver());
    lights.add(receiver(), { receiveShadow: false });
    const [shadowed, unshadowed] = handed;
    assert.equal(shadowed, lights);
    assert.notEqual(unshadowed, lights);
    assert.equal(unshadowed.owner, lights.owner);
    assert.ok(shadowed.pbr(2).declarations.includes('clusterShadowVisibility(light,position,n)'));
    assert.ok(!unshadowed.pbr(2).declarations.includes('clusterShadowVisibility'));
    assert.equal(unshadowed.pbr(2), unshadowed.pbr(2), 'hooks are cached');
    assert.equal(unshadowed.pbr(2).declarations, clusteredSampling(2));
    assert.deepEqual(
      shadowed.bindings().map((entry) => entry.binding),
      [4, 5, 6, 7, 28, 29, 30],
    );
    assert.deepEqual(
      unshadowed.bindings().map((entry) => entry.binding),
      [4, 5, 6, 7],
    );
    assert.equal(unshadowed.bindings(), unshadowed.bindings(), 'a stable bindings array');
    assert.ok(!unshadowed.shader(wgsl).includes('clusterShadowVisibility'));
    assert.ok(lights.shader(wgsl).includes('clusterShadowVisibility'));
    assert.throws(() => lights.add(receiver(), { receiveShadow: 'no' }), TypeError);
    remove();
    assert.equal(handed.at(-1), 'removed');
  } finally {
    lights.dispose();
  }
});

test('core meshes with receiveShadow false skip local-light shadows; the patch exists only while the engine has one', () => {
  const h = harness(),
    lights = new Clustered({ grid: [2, 2, 2], shadows: { maxLights: 1 } }),
    plain = new Clustered({ grid: [2, 2, 2] });
  lights.setLights([{ position: [0, 2, 1], range: 6, shadow: true }]);
  h.engine.use(lights);
  try {
    h.frame();
    const original = h.context.shader,
      hook = lights.pbr(2).declarations;
    h.engine.unshadowed = 1;
    h.frame();
    const patched = h.context.shader;
    assert.ok(patched.includes('\nvar<private> clusterReceive=true;\n'));
    assert.ok(patched.includes('clusterReceive=fract(i.material.z+0.125)<0.25;let linear='));
    assert.ok(patched.includes('*select(1.0,clusterShadowVisibility(light,position,n),clusterReceive);'));
    assert.equal(lights.pbr(2).declarations, hook, 'model hooks are unchanged');
    assert.ok(!lights.shader('let linear=direct;').includes('clusterReceive'), 'only core-shaped shaders');
    assert.ok(
      clusteredSampling(0, { declarations: () => '' }, undefined, false, false, true).includes(
        '*select(1.0,clusterShadow(light,position,n),clusterReceive);',
      ),
      'LocalShadows terms too',
    );
    h.engine.unshadowed = 0;
    h.frame();
    assert.equal(h.context.shader, original, 'the original text once no core mesh opts out');
    h.engine.removePlugin(lights.name);
    h.engine.use(plain);
    h.frame();
    const unlit = h.context.shader;
    h.engine.unshadowed = 1;
    h.frame();
    assert.equal(h.context.shader, unlit, 'without local shadows there is nothing to skip');
  } finally {
    lights.dispose();
    plain.dispose();
  }
});

test('a spot of exactly pi/2 (a hemisphere) is accepted as angle or outerAngle and packed like any cone', () => {
  const lights = new Clustered({ grid: [2, 2, 2] }),
    spot = { position: [0, 3, 0], range: 6, direction: [0, -1, 0] };
  lights.setLights([
    { ...spot, angle: Math.PI / 2 },
    { ...spot, angle: Math.PI / 2, penumbra: 0.5 },
    { ...spot, outerAngle: Math.PI / 2, innerAngle: 1 },
  ]);
  const data = lights['data'];
  assert.deepEqual(
    [data[11], data[12], data[13], data[16 + 12], data[32 + 11], data[32 + 12], data[32 + 13]],
    [Math.cos(Math.PI / 2), Math.cos(Math.PI / 2), 4, Math.cos(Math.PI / 4), Math.cos(Math.PI / 2), Math.cos(1), 1].map(
      Math.fround,
    ),
  );
  lights.dispose();
});

test("cluster culling never drops a cluster a spot lights, up to pi/2 (CPU mirror of cullingShader's cone test)", () => {
  // The mirror below repeats these lines; the shader must still have them.
  for (const line of [
    'let delta=p-clamp(p,lo,hi);if(dot(delta,delta)>light.positionRange.w*light.positionRange.w){continue;}',
    'let relative=center-p;let axial=dot(relative,direction);let radial=length(relative-direction*axial);',
    'let cosine=light.directionOuter.w;let sine=sqrt(max(0.0,1-cosine*cosine));',
    'if(axial+radius<0||radial*cosine-axial*sine>radius){continue;}',
  ])
    assert.ok(cullingShader.includes(line), line);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    sub = (a, b) => a.map((v, i) => v - b[i]);
  const kept = (lo, hi, p, direction, cosine, range) => {
    const delta = sub(
      p,
      p.map((v, i) => Math.min(Math.max(v, lo[i]), hi[i])),
    );
    if (dot(delta, delta) > range * range) return false;
    const center = lo.map((v, i) => (v + hi[i]) / 2),
      radius = Math.hypot(...sub(hi, lo)) / 2,
      relative = sub(center, p),
      axial = dot(relative, direction),
      radial = Math.hypot(...relative.map((v, i) => v - direction[i] * axial)),
      sine = Math.sqrt(Math.max(0, 1 - cosine * cosine));
    return !(axial + radius < 0 || radial * cosine - axial * sine > radius);
  };
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
  const p = [0.3, -0.2, -5],
    direction = [0.36, 0.48, -0.8],
    range = 6;
  for (const angle of [0.3, 1.2, 1.55, Math.PI / 2]) {
    const cosine = Math.fround(Math.cos(angle));
    let lit = 0,
      culled = 0;
    for (let n = 0; n < 4000; n++) {
      const size = [0.2 + Math.abs(random()), 0.2 + Math.abs(random()), 0.2 + Math.abs(random())],
        lo = p.map((v, i) => v + random() * 8 - size[i] / 2),
        hi = lo.map((v, i) => v + size[i]);
      let any = false;
      for (let k = 0; k < 125 && !any; k++) {
        const q = lo.map((v, i) => v + (hi[i] - v) * ((Math.floor(k / 5 ** i) % 5) / 4)),
          d = Math.hypot(...sub(q, p));
        any = d > 0 && d < range && dot(sub(q, p), direction) / d >= cosine;
      }
      if (any) {
        lit++;
        assert.ok(
          kept(lo, hi, p, direction, cosine, range),
          `angle ${angle}: a lit cluster [${lo}]-[${hi}] was culled`,
        );
      } else if (!kept(lo, hi, p, direction, cosine, range)) culled++;
    }
    assert.ok(lit > 30 && culled > 1000, `angle ${angle}: ${lit} lit clusters, ${culled} culled`);
  }
});

test("a pi/2 spot's falloff and cone are bvh bakeVertexColors' numbers", () => {
  // Vertices 2 m from a spot along +x, each facing it (Lambert 1), at 0 to 120 degrees off the axis.
  const degrees = [0, 30, 44, 60, 89, 91, 120],
    positions = degrees.flatMap((a) => [2 * Math.cos((a * Math.PI) / 180), 2 * Math.sin((a * Math.PI) / 180), 0]),
    normals = positions.map((v) => -v / 2);
  for (const [penumbra, decay, range] of [
    [0, 2, 0],
    [0.5, 1, 5],
    [1, 0, 3],
  ]) {
    const baked = bakeVertexColors({ positions, normals }, null, {
      shadows: false,
      lights: [
        {
          type: 'spot',
          position: [0, 0, 0],
          direction: [1, 0, 0],
          angle: Math.PI / 2,
          penumbra,
          decay,
          distance: range,
        },
      ],
    });
    degrees.forEach((a, k) => {
      const want = attenuation(2, range, decay) * cone(Math.PI / 2, penumbra, Math.cos((a * Math.PI) / 180));
      assert.ok(
        Math.abs(baked[k * 4] - want) < 1e-6,
        `penumbra ${penumbra}, ${a} degrees: bake ${baked[k * 4]}, ${want}`,
      );
    });
    assert.equal(baked[5 * 4], 0, 'nothing behind the hemisphere');
  }
});
