import test from 'node:test';
import assert from 'node:assert/strict';
import { box, Geometry, PbrMaterial } from '@margoengine/core';
import { Scatter } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { wgsl } from '../../core/src/shaders.ts';
test('scatter distributes on GPU and issues three bounded indirect LOD draws', () => {
  const h = optionalGPU(),
    effect = new Scatter([box(), box(0.5), box(0.25)], { count: 64 });
  h.engine.use(effect);
  h.frame();
  assert.equal(h.counts.compute, 1);
  assert.equal(h.counts.indirect, 3);
  effect.onDeviceRestored(h.engine);
  h.frame();
  effect.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
  assert.throws(() => new Scatter(box(), { lod: [20, 10, 30] }), /rules/);
  assert.throws(() => new Scatter(box(), { maxSlope: 91 }), /rules/);
});
test('scatter interpolates the four cell-centre heights around each instance and takes the normal from that patch', () => {
  const h = optionalGPU(),
    effect = new Scatter(box(), { count: 1 });
  h.engine.use(effect);
  h.frame();
  const code = h.pipelines.find((p) => p.compute).compute.module.code;
  assert.match(code, /let texel=uv\*vec2f\(size\)-0\.5;let cell=vec2i\(floor\(texel\)\);/);
  for (const corner of ['cell)', 'cell+vec2i(1,0))', 'cell+vec2i(0,1))', 'cell+vec2i(1,1))'])
    assert.ok(code.includes('=height(' + corner), corner);
  assert.match(code, /let h=mix\(mix\(h00,h10,f\.x\),mix\(h01,h11,f\.x\),f\.y\)\+frame\.scale\.z;/);
  assert.doesNotMatch(code, /vec2i\(uv\*vec2f\(size\)\)/, 'no nearest-texel read');
  effect.dispose();
});

test('alignToGround and sink fit instances to the ground in the cull and both vertex shaders', () => {
  const plain = new Scatter(box());
  assert.deepEqual(Array.from(plain.values.slice(72, 74)), [0, 0], 'defaults: upright, not sunk');
  const fitted = new Scatter(box(), { alignToGround: 1, sink: 0.25 });
  assert.deepEqual(Array.from(fitted.values.slice(72, 74)), [1, 0.25]);
  for (const options of [{ alignToGround: 1.5 }, { alignToGround: -0.1 }, { alignToGround: NaN }, { sink: -1 }])
    assert.throws(() => new Scatter(box(), options), { name: 'RangeError', message: /alignToGround must be 0-1/ });
  for (const lit of [false, true]) {
    const h = optionalGPU();
    h.engine.lighting = {
      direction: new Float32Array([-1, 0.13, 0, 1]),
      radiance: new Float32Array([1, 0.8, 0.54, 0.18]),
    };
    h.context.shader = wgsl;
    h.context.bindings = [];
    const effect = new Scatter([box(), box(0.5), box(0.25)], {
      count: 4,
      alignToGround: 0.5,
      sink: 0.1,
      ...(lit ? { material: new PbrMaterial() } : {}),
    });
    h.engine.use(effect);
    h.engine.frameGraph.execute(h.context);
    const cull = h.pipelines.find((p) => p.compute).compute.module.code,
      render = h.pipelines.find((p) => p.fragment).vertex.module.code;
    // Sink scales with tan(slope); the ground normal's X and Z are packed beside the yaw.
    assert.match(cull, /h-frame\.ground\.y\*scale\*\(1\.0\+length\(normal\.xz\)\/max\(normal\.y,0\.2\)\)/);
    assert.match(cull, /vec4f\(angle,q\.x\+q\.y\*4096\.0,0,0\)/);
    assert.match(render, /fn scatterTurn\(/);
    assert.match(
      render,
      lit
        ? /scatterPose\(p,n,data\.position,data\.rotation,material\[3\],material\[4\],frame\.eye\.xyz,material\[2\]\)/
        : /frame\.ground,frame\.blade,frame\.eye\.xyz,frame\.wind\)/,
    );
    if (lit) {
      assert.match(render, /var<uniform> material:array<vec4f,5>/);
      assert.equal(effect.materialUniform.size, 80);
      assert.deepEqual(Array.from(new Float32Array(effect.materialUniform.data).subarray(12, 14)), [
        0.5,
        Math.fround(0.1),
      ]);
    }
    effect.dispose();
  }
});

test('edgeShrink scales instances to zero over the last stretch before the cull distance instead of cutting them', () => {
  assert.equal(new Scatter(box()).values[74], 0, 'default: cut at the last LOD distance');
  assert.equal(new Scatter(box(), { lod: [10, 20, 40], edgeShrink: 8 }).values[74], 8);
  assert.equal(new Scatter(box(), { lod: [10, 20, 40], edgeShrink: 500 }).values[74], 40, 'clamped to the distance');
  for (const edgeShrink of [-1, NaN, Infinity])
    assert.throws(() => new Scatter(box(), { edgeShrink }), { name: 'RangeError', message: /edgeShrink must be/ });
  const h = optionalGPU(),
    effect = new Scatter([box(), box(0.5), box(0.25)], { count: 1, lodFade: 0, edgeShrink: 8 });
  h.engine.use(effect);
  h.frame();
  const cull = h.pipelines.find((p) => p.compute).compute.module.code,
    render = h.pipelines.find((p) => p.fragment).vertex.module.code;
  assert.match(
    cull,
    /let shrink=select\(1\.0,clamp\(\(frame\.lod\.z-d\)\/frame\.ground\.z,0\.0,1\.0\),frame\.ground\.z>0\.0\);/,
  );
  assert.match(cull, /Instance\(vec4f\(p,scale\*shrink\),/);
  assert.doesNotMatch(render, /discard/, 'shrinking needs no discard');
  effect.dispose();
});

test('blades shade grass from root to tip and bend lit normals toward the ground only when asked', () => {
  const blade = new Geometry(
      [-0.04, 0, 0, 0.04, 0, 0, 0, 0.5, 0],
      [0, 0.24, 0.97, 0, 0.24, 0.97, 0, 0.24, 0.97],
      [0, 1, 2],
    ),
    plain = new Scatter(blade),
    grass = new Scatter(blade, { lod: [10, 20, 40], blades: {} });
  assert.deepEqual(Array.from(plain.values.slice(76, 80)), [0, 0, 0, 0], 'off by default');
  assert.deepEqual(
    Array.from(grass.values.slice(76, 80)),
    [0.5, 1 / 40, 2, 1 / 40].map(Math.fround),
    'rootShade, widen per unit of distance, 1 / tip height, 1 / last distance',
  );
  assert.equal(grass.values[35], Math.fround(plain.values[35] * 2), 'cull bounds cover blades twice as wide');
  const tuned = new Scatter(blade, { lod: [10, 20, 40], blades: { rootShade: 0.7, widen: 0.5 } });
  assert.deepEqual(Array.from(tuned.values.slice(76, 78)), [0.7, 0.5 / 40].map(Math.fround));
  for (const blades of [{ rootShade: 1.2 }, { rootShade: -0.1 }, { widen: -1 }, { widen: 11 }, { widen: NaN }])
    assert.throws(() => new Scatter(blade, { blades }), { name: 'RangeError', message: /rootShade 0-1 and widen/ });
  assert.throws(() => new Scatter(blade, { blades: 1 }), { name: 'TypeError', message: /options object/ });
  const flat = new Geometry([0, 0, 0, 1, 0, 0, 0, 0, 1], [0, 1, 0, 0, 1, 0, 0, 1, 0], [0, 1, 2]);
  assert.throws(() => new Scatter(flat, { blades: {} }), { name: 'RangeError', message: /rise above/ });
  const build = (options) => {
    const h = optionalGPU();
    h.engine.lighting = {
      direction: new Float32Array([-1, 0.13, 0, 1]),
      radiance: new Float32Array([1, 0.8, 0.54, 0.18]),
    };
    h.context.shader = wgsl;
    h.context.bindings = [];
    const effect = new Scatter(
      [blade, blade, new Geometry([0, 0, 0, 0.1, 0, 0, 0, 0.5, 0], [0, 0, 1, 0, 0, 1, 0, 0, 1], [0, 1, 2])],
      {
        count: 4,
        ...options,
      },
    );
    h.engine.use(effect);
    h.engine.frameGraph.execute(h.context);
    const code = h.pipelines.find((p) => p.fragment).vertex.module.code,
      material = effect.materialUniform && Array.from(new Float32Array(effect.materialUniform.data));
    effect.dispose();
    return { code, material };
  };
  const bent = 'let n=normalize(mix(normalize(i.normal)*select(-1.0,1.0,facing),i.ground.xyz,i.ground.w));';
  for (const lodFade of [2, 0]) {
    const lit = build({ lodFade, blades: {}, material: new PbrMaterial({ doubleSided: true }) });
    assert.ok(lit.code.includes(bent), `lodFade ${lodFade}: the shading normal bends after the back-face flip`);
    // Centroid: with multisampling a partly covered pixel is shaded inside the blade, where the shade and ground
    // weight stay in range (at the pixel centre they extrapolated and drew negative light at blade edges).
    assert.match(lit.code, /@location\(5\) @interpolate\(perspective,centroid\) ground:vec4f/);
    assert.match(lit.code, /@location\(2\) @interpolate\(perspective,centroid\) color:vec3f/);
    assert.match(lit.code, /o\.color=material\[0\]\.rgb\*pose\.shade;/);
    assert.match(lit.code, /o\.ground=pose\.ground;/);
    assert.match(lit.code, /var<uniform> material:array<vec4f,5>/);
    assert.equal(lit.code.includes('lodVisible'), lodFade > 0);
    assert.deepEqual(lit.material.slice(16, 20), [0.5, 1 / 120, 2, 1 / 120].map(Math.fround));
    const off = build({ lodFade, material: new PbrMaterial({ doubleSided: true }) });
    assert.ok(off.code.includes('let n=normalize(i.normal)*select(-1.0,1.0,facing);'), 'core normal untouched');
    assert.doesNotMatch(off.code, /i\.ground|pose\.shade|centroid/);
    const unlit = build({ lodFade, blades: {} });
    assert.match(
      unlit.code,
      /let n=normalize\(mix\(normalize\(i\.normal\)\*select\(-1\.0,1\.0,front\),i\.ground\.xyz,i\.ground\.w\)\);/,
    );
    assert.match(unlit.code, /frame\.color\.rgb\*i\.shade\*/);
    assert.match(unlit.code, /@location\(3\) @interpolate\(perspective,centroid\) shade:f32/);
  }
});

test('variation and clusters tint lit instances and cluster their shading only when asked', () => {
  const material = () => new PbrMaterial({ color: [0.2, 0.5, 0.1] });
  for (const variation of [{ hue: 0.6 }, { hue: -0.1 }, { value: 1.5 }, { value: NaN }])
    assert.throws(() => new Scatter(box(), { material: material(), variation }), {
      name: 'RangeError',
      message: /hue 0-0.5 and value 0-1/,
    });
  assert.throws(() => new Scatter(box(), { material: material(), variation: 1 }), {
    name: 'TypeError',
    message: /options object/,
  });
  for (const clusters of [-1, NaN, Infinity])
    assert.throws(() => new Scatter(box(), { material: material(), clusters }), {
      name: 'RangeError',
      message: /clusters must be/,
    });
  for (const look of [{ variation: { hue: 0.1 } }, { clusters: 0.5 }])
    assert.throws(() => new Scatter(box(), look), { name: 'RangeError', message: /pass material/ });
  // Off (unset or zero) needs no material and changes nothing.
  assert.equal(new Scatter(box(), { variation: { hue: 0, value: 0 }, clusters: 0 }).values[75], 0);
  const build = (options) => {
    const h = optionalGPU();
    h.engine.lighting = { direction: new Float32Array([0, 1, 0, 1]), radiance: new Float32Array([1, 1, 1, 0]) };
    h.context.shader = wgsl;
    h.context.bindings = [];
    const effect = new Scatter(box(), { count: 4, material: material(), ...options });
    h.engine.use(effect);
    h.engine.frameGraph.execute(h.context);
    const code = h.pipelines.find((p) => p.fragment).vertex.module.code,
      values = Array.from(new Float32Array(effect.materialUniform.data));
    effect.dispose();
    return { code, values };
  };
  const plain = build({}),
    zero = build({ variation: { hue: 0, value: 0 }, clusters: 0 });
  assert.equal(zero.code, plain.code, 'zero is the original shader, byte for byte');
  assert.deepEqual(zero.values, plain.values, 'and the original uniform');
  assert.doesNotMatch(plain.code, /scatterHash|tint|bent/);
  assert.match(plain.code, /o\.color=material\[0\]\.rgb;/);
  const tinted = build({ variation: { hue: 0.06, value: 0.15 } });
  assert.match(tinted.code, /fn scatterHue\(/);
  assert.match(tinted.code, /floor\(data\.position\.xz\*4\.0\)/, 'keyed by world position, not the instance index');
  assert.match(tinted.code, /o\.color=tint;/);
  assert.match(tinted.code, /scatterPose\(p,n,/, 'no clusters: the mesh normal');
  assert.deepEqual([tinted.values[3], tinted.values[7]], [0.06, 0.15].map(Math.fround), 'hue and value slots');
  assert.deepEqual(tinted.values.slice(0, 3), plain.values.slice(0, 3), 'the material colour itself is unchanged');
  const clustered = build({ variation: { value: 0.2 }, clusters: 0.6, blades: {} });
  assert.match(clustered.code, /let cell=floor\(p\/material\[3\]\.w\);/);
  assert.match(clustered.code, /scatterPose\(p,bent,/, 'the cluster normal is posed like the mesh normal');
  assert.match(clustered.code, /o\.color=tint\*pose\.shade;/, 'blades still shade the tinted colour');
  assert.equal(clustered.values[15], Math.fround(0.6), 'cell size in ground.w');
});

test('scatter frustum bounds include geometry displaced from its local origin', () => {
  const h = optionalGPU(),
    geometry = new Geometry([10, 0, 0, 11, 0, 0, 10, 1, 0], [0, 0, 1, 0, 0, 1, 0, 0, 1], [0, 1, 2]),
    effect = new Scatter(geometry, { count: 1 });
  h.engine.use(effect);
  h.frame();
  const uniform = h.resources.find((r) => r.data?.byteLength === effect.values.byteLength),
    radius = new Float32Array(uniform.data)[35];
  assert.ok(radius >= 10.5 + geometry.bounds[3]);
  effect.dispose();
});

test('GPU exclusions are validated and uploaded once across frames and device restoration', () => {
  const h = optionalGPU(),
    exclusions = [[-3, -2, 1, 4]],
    effect = new Scatter(box(), { count: 1, exclusions });
  exclusions[0][0] = 100;
  h.engine.use(effect);
  h.frame();
  assert.equal(effect.values[19], 1);
  assert.deepEqual(Array.from(new Float32Array(effect.exclusionBuffer.data)), [-3, -2, 1, 4]);
  const code = h.pipelines.find((p) => p.compute).compute.module.code;
  assert.match(code, /p\.xz-clamp\(p\.xz,bounds\.xy,bounds\.zw\)/);
  assert.match(code, /dot\(offset,offset\)<=radius\*radius/);
  const created = { ...h.counts };
  for (let i = 0; i < 600; i++) h.frame();
  assert.equal(h.counts.buffers, created.buffers);
  assert.equal(h.counts.groups, created.groups);
  effect.onDeviceRestored(h.engine);
  h.frame();
  assert.deepEqual(Array.from(new Float32Array(effect.exclusionBuffer.data)), [-3, -2, 1, 4]);
  effect.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
  assert.throws(() => new Scatter(box(), { exclusions: [[1, 0, 0, 1]] }), /exclusion/);
  const limited = optionalGPU();
  limited.engine.gpu.limits.maxStorageBufferBindingSize = 32;
  assert.throws(
    () =>
      limited.engine.use(
        new Scatter(box(), {
          count: 1,
          exclusions: [
            [0, 0, 1, 1],
            [2, 0, 3, 1],
            [4, 0, 5, 1],
          ],
        }),
      ),
    /GPU limits/,
  );
  assert.equal(limited.counts.buffers, 0);
});

test('scatter defaults to farther LODs and clamps fade bands without changing explicit distances', () => {
  const near = box(),
    middle = box(0.8),
    far = box(0.6),
    effect = new Scatter([near, middle, far]);
  assert.deepEqual(Array.from(effect.values.slice(32, 35)), [25, 60, 120]);
  assert.equal(effect.values[31], 2);
  assert.equal(effect.meta[39], 3);
  const narrow = new Scatter([near, near, far], { lod: [0.1, 0.2, 0.3] });
  assert.equal(narrow.values[31], Math.fround(0.1));
  assert.equal(narrow.meta[39], 2);
  assert.equal(new Scatter(near).meta[39], 0, 'Shared geometry needs no duplicate transition draw');
  assert.equal(new Scatter([near, middle, far], { lodFade: 0 }).values[31], 0);
  for (const lodFade of [-1, NaN, Infinity, 100001]) assert.throws(() => new Scatter(near, { lodFade }), /LOD fade/);
});

test('PBR scatter reuses standard lighting and shadow bindings without rebuilding steady-state GPU resources', () => {
  const h = optionalGPU();
  h.engine.lighting = {
    direction: new Float32Array([-1, 0.13, 0, 1]),
    radiance: new Float32Array([1, 0.8, 0.54, 0.18]),
  };
  h.context.shader = wgsl.replace('let linear=direct*', 'let linear=direct*0.75*');
  h.context.bindings = [{ binding: 1, resource: { buffer: {} } }];
  const effect = new Scatter(box(), {
    count: 64,
    material: new PbrMaterial({ color: [0.19, 0.28, 0.09], roughness: 0.95 }),
  });
  h.engine.use(effect);
  h.engine.frameGraph.execute(h.context);
  const render = h.pipelines.find((p) => p.fragment),
    code = render.vertex.module.code;
  assert.match(code, /@group\(1\) @binding\(0\)/);
  assert.match(code, /let linear=direct\*0\.75\*/);
  assert.doesNotMatch(code, /i\.m0/);
  assert.doesNotMatch(code, /lodVisible|lodFade/, 'one shared mesh never fades: no dither discard');
  // Double-sided, under a patched shader and a shadow binding: core draws it with its plain pipeline (C false).
  assert.equal(render.fragment.constants, undefined, "C follows core's plain pipeline");
  assert.equal(render.primitive, undefined, 'double-sided: nothing culled');
  assert.ok(h.groups.some((g) => g.entries.some((e) => e.resource === h.context.bindings[0].resource)));
  const created = { ...h.counts };
  for (let i = 0; i < 600; i++) h.engine.frameGraph.execute(h.context);
  assert.equal(h.counts.buffers, created.buffers);
  assert.equal(h.counts.groups, created.groups);
  assert.equal(h.counts.indirect, 601 * 3);
  effect.onDeviceRestored(h.engine);
  h.engine.frameGraph.execute(h.context);
  effect.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
  assert.throws(() => new Scatter(box(), { material: {} }), /material/);
});

// Any discard in a fragment shader stops tile-based phone GPUs from rejecting hidden fragments before shading.
test('the LOD dither discard is compiled only when instances can fade', () => {
  const near = box(),
    middle = box(0.5),
    far = box(0.25);
  const build = (geometry, options) => {
    const h = optionalGPU();
    h.engine.lighting = {
      direction: new Float32Array([-1, 0.13, 0, 1]),
      radiance: new Float32Array([1, 0.8, 0.54, 0.18]),
    };
    h.context.shader = wgsl;
    h.context.bindings = [];
    const effect = new Scatter(geometry, { count: 64, ...options });
    h.engine.use(effect);
    h.engine.frameGraph.execute(h.context);
    const pipeline = h.pipelines.find((p) => p.fragment);
    effect.dispose();
    return pipeline;
  };
  const discard = 'if(!lodVisible(i.clip.xy,i.lodFade)){discard;}';
  for (const lit of [false, true]) {
    const material = () => (lit ? { material: new PbrMaterial({ doubleSided: false }) } : {}),
      fading = build([near, middle, far], material());
    assert.ok(fading.vertex.module.code.includes(discard), `${lit}: three meshes and the default fade keep the dither`);
    assert.equal(fading.fragment.constants, undefined, `${lit}: the fading pipeline is unchanged`);
    assert.equal(fading.primitive, undefined);
    for (const [geometry, options, why] of [
      [[near, middle, far], { lodFade: 0 }, 'lodFade 0'],
      [near, {}, 'one shared mesh'],
      [[near, near, near], {}, 'three references to one mesh'],
    ]) {
      const solid = build(geometry, { ...material(), ...options }),
        code = solid.vertex.module.code;
      assert.doesNotMatch(code, /lodVisible|lodFade|bayer/, `${lit}: ${why}`);
      if (lit) {
        assert.deepEqual(solid.fragment.constants, { C: 1 }, `${why}: core's back-face discard is compiled out`);
        assert.deepEqual(solid.primitive, { cullMode: 'back' }, `${why}: single-sided culls in the rasterizer`);
      } else {
        assert.doesNotMatch(code, /discard/, why);
        assert.equal(solid.fragment.constants, undefined);
      }
    }
  }
});

test('Scatter reads lodFade from the tier preset (margoPreset.scatter) only when the app left it unset', () => {
  const geometries = [box(), box(0.5), box(0.25)],
    options = {};
  assert.equal(new Scatter(geometries, options).options, options, 'no preset: the app object is used as is');
  globalThis.margoPreset = { scatter: { lodFade: 0 } };
  try {
    const preset = new Scatter(geometries, options);
    assert.equal(preset.values[31], 0);
    assert.notEqual(preset.options, options);
    assert.deepEqual(options, {}, 'the app object is not changed');
    assert.equal(new Scatter(geometries, { lodFade: 2 }).values[31], 2, 'explicit options win');
  } finally {
    delete globalThis.margoPreset;
  }
});

// As culling's c89c0186c: under a shader patched by Shadows core draws single-sided meshes with its plain pipeline
// (C false), and Metal rounds the C=1 and C false specializations of one shader apart.
test('the back-culled lit pipeline sets C=1 only when core would draw the frame with its own C=1 pipeline', () => {
  for (const [label, patch, own] of [
    ['unpatched', () => {}, true],
    [
      'shader and bindings patched, as Shadows does',
      (c) => {
        c.shader = `${c.shader}\n// patched`;
        c.bindings.push({ binding: 1, resource: { buffer: {} } });
      },
      false,
    ],
    ['shader patched alone', (c) => (c.shader = `${c.shader}\n// patched`), false],
    ['a binding alone', (c) => c.bindings.push({ binding: 1, resource: { buffer: {} } }), false],
  ]) {
    const h = optionalGPU();
    h.engine.lighting = {
      direction: new Float32Array([-1, 0.13, 0, 1]),
      radiance: new Float32Array([1, 0.8, 0.54, 0.18]),
    };
    h.context.bindings = [];
    const effect = new Scatter(box(), { count: 64, material: new PbrMaterial({ doubleSided: false }) });
    h.engine.use(effect);
    h.engine.frameGraph.add({ name: 'patch', order: -5, execute: patch });
    // Core resets the shader and bindings at the start of every frame.
    for (let i = 0; i < 2; i++) {
      h.context.shader = wgsl;
      h.context.bindings.length = 0;
      h.engine.frameGraph.execute(h.context);
    }
    const culled = h.pipelines.filter((p) => p.primitive?.cullMode === 'back');
    assert.equal(culled.length, 1, `${label}: one back-culled pipeline`);
    assert.equal(culled[0].fragment.constants?.C, own ? 1 : undefined, `${label}: C follows core's choice`);
    effect.dispose();
  }
});
