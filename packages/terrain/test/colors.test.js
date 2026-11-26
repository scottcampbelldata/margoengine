import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore, meshRuntime } from '@margoengine/core/extension';
import { TerrainColors, heightfield, wetSandAfter } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { wgsl } from '../../core/src/shaders.ts';

const options = {
  sand: [0.4, 0.3, 0.2],
  meadow: [
    [0.1, 0.2, 0.1],
    [0.2, 0.3, 0.1],
  ],
  stone: [0.3, 0.3, 0.3],
  shore: [0, 1],
  meadowHeight: [1, 10],
  stoneHeight: [10, 20],
  stoneNormal: [0.5, 0.8],
  wetHeight: [0, 0.6],
  wetDarkening: 0.55,
};
// The block terrain colors open after core's shading normal; it shadows `i` and `n` with per-pixel copies.
const block = 'let terrainSource=i;let terrainNormal=n;{var i=terrainSource;var n=terrainNormal;';
const near = (a, b) => Math.abs(a - b) < 1e-5;
const balanced = (code) => {
  let depth = 0;
  for (const char of code)
    if (char === '{') depth++;
    else if (char === '}' && --depth < 0) return false;
  return depth === 0;
};
const shaderEngine = async () =>
  new Engine({ width: 10, height: 10 }, await TransformStore.create(8), {
    backend: 'webgpu',
    gpu: optionalGPU().engine.gpu,
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });

test('multiple wet terrains share the mesh ID varying and keep distinct textures and wetness functions', async () => {
  const h = optionalGPU(),
    engine = new Engine({ width: 128, height: 96 }, await TransformStore.create(8), {
      backend: 'webgpu',
      gpu: h.engine.gpu,
      add() {},
      remove() {},
      render() {},
      dispose() {},
    });
  const meshes = [engine.createMesh(), engine.createMesh()];
  const effects = meshes.map(
    (mesh, i) =>
      new TerrainColors(mesh, { ...options, wetness: { texture: () => undefined, origin: [i * 4, 0], size: [4, 4] } }),
  );
  for (const effect of effects) engine.use(effect);
  try {
    h.context.shader = wgsl;
    h.context.bindings = [];
    engine.frameGraph.execute(h.context);
    const code = h.context.shader,
      bindings = h.context.bindings.map((e) => e.binding);
    // Two wet textures and two look uniforms, each on its own binding.
    assert.equal(new Set(bindings).size, 4);
    assert.equal(code.match(/terrainId:f32/g)?.length, 1);
    assert.equal(code.match(/o.terrainId=i.factors.w\+1.0/g)?.length, 1);
    const functions = [...code.matchAll(/fn (terrainWet\w*)\(/g)].map((m) => m[1]);
    assert.equal(new Set(functions).size, 2);
    for (const mesh of meshes) assert.match(code, new RegExp(`if\\(i.terrainId==${meshRuntime(mesh).id + 1}\\.0\\)`));
    // Both meshes share one per-pixel block that closes with the fragment.
    assert.equal(code.split(block).length - 1, 1);
    assert.equal(code.match(/struct TerrainSurface /g)?.length, 1);
    assert.ok(balanced(code));
  } finally {
    engine.dispose();
    h.cleanup();
  }
});
// KB-TERRAIN-SAND3: the ripple clamp's footprint is the pixel's own (screen-space derivatives of the position), taken once
// where control flow is uniform, before every mesh's call; it was distance / 1000 whatever the frame size.
test('terrain colors take the real pixel footprint once, before every mesh call', async () => {
  const engine = await shaderEngine();
  const first = engine.createMesh(),
    second = engine.createMesh();
  engine.use(new TerrainColors(first, options));
  engine.use(new TerrainColors(second, options));
  const c = { backend: 'webgpu', shader: wgsl, bindings: [], draw() {} };
  engine.frameGraph.execute(c);
  const line = 'let terrainColorFootprint=max(length(dpdx(i.position)),length(dpdy(i.position)));',
    at = c.shader.indexOf(line);
  assert.ok(at >= 0, 'the footprint line is in the shader');
  assert.equal(c.shader.indexOf(line, at + 1), -1, 'the footprint is taken once');
  for (const mesh of [first, second]) {
    const id = meshRuntime(mesh).id,
      call = c.shader.indexOf(`let s=terrainSurface_${id}(i.position,n,terrainColorFootprint);`);
    assert.ok(call > at, `mesh ${id}'s call comes after the footprint`);
  }
  assert.doesNotMatch(c.shader, /sd\*0\.001/, 'no distance-based footprint guess');
  assert.ok(balanced(c.shader));
});

test('terrain colors shade one mesh per pixel inside core lighting and cache the patch', async () => {
  const engine = await shaderEngine();
  const mesh = engine.createMesh(),
    other = engine.createMesh(),
    colors = new TerrainColors(mesh, options);
  engine.use(colors);
  const c = { backend: 'webgpu', shader: wgsl, bindings: [], draw() {} };
  engine.frameGraph.execute(c);
  const id = meshRuntime(mesh).id;
  assert.ok(
    c.shader.includes(`if(i.terrainId==${id + 1}.0){let s=terrainSurface_${id}(i.position,n,terrainColorFootprint);`),
  );
  assert.ok(!c.shader.includes(`terrainSurface_${meshRuntime(other).id}(`));
  // Bands are evaluated per pixel from the interpolated height and normal, not in the vertex stage.
  assert.ok(c.shader.includes(`fn terrainSurface_${id}(p:vec3f,n:vec3f,footprint:f32)->TerrainSurface`));
  assert.doesNotMatch(c.shader, /o\.color=mix/);
  assert.ok(c.shader.includes('let linear=direct*'));
  assert.ok(balanced(c.shader));
  const patched = c.shader;
  c.shader = wgsl;
  engine.frameGraph.execute(c);
  assert.equal(c.shader, patched);
  assert.throws(() => new TerrainColors(mesh, { ...options, wetDarkening: 2 }), /wetness/);
  assert.throws(() => new TerrainColors(mesh, { ...options, shore: [1, 1] }), /range/);
  // Without core's standard shader the mesh keeps its material color.
  const foreign = 'o.color=i.color.rgb; // not the standard PBR shader';
  c.shader = foreign;
  engine.frameGraph.execute(c);
  assert.equal(c.shader, foreign);
  colors.dispose();
  c.shader = wgsl;
  engine.frameGraph.execute(c);
  assert.equal(c.shader, wgsl);
  engine.dispose();
});

test('the per-pixel block keeps the anchors later core patches use and survives their rewrites', async () => {
  const engine = await shaderEngine(),
    mesh = engine.createMesh();
  engine.use(new TerrainColors(mesh, { ...options, variation: 0.1 }));
  const c = { backend: 'webgpu', shader: wgsl, bindings: [], draw() {} };
  engine.frameGraph.execute(c);
  const code = c.shader;
  for (const anchor of [
    'o.color=i.color.rgb;',
    '@location(3) material:vec4f',
    '@fragment fn fragment(i:Output,@builtin(front_facing) front:bool)->@location(0) vec4f',
    'let facing=',
    'let n=normalize(i.normal)',
    'let v=normalize(frame.eye.xyz-i.position)',
    'let linear=direct*',
    'i.color*(1.0-i.material.y)*frame.radiance.w',
    'let mapped=pbrNeutral(max(linear,vec3f(0)));',
  ])
    assert.equal(code.split(anchor).length - 1, 1, anchor);
  assert.equal(code.match(/fn terrainNoise\(/g)?.length, 1);
  // Core's GPU pick keeps the fragment only up to the shading normal: the block goes with the rest.
  const pick = code
    .replace('->@location(0) vec4f {', '->@location(0) u32 {')
    .replace(/let n=normalize\(i.normal\)[\s\S]*$/, 'return i.id;\n}');
  assert.ok(balanced(pick));
  assert.doesNotMatch(pick, /terrainSource/);
  // HDR capture (bloom, post stack) and the SSAO/SSR replays rewrite the tail inside the block, after the terrain call.
  const hdr = code.replace(/let mapped=pbrNeutral\([\s\S]*?return vec4f\([^\n]+\);/, 'return vec4f(linear,1);');
  assert.ok(hdr !== code && balanced(hdr));
  const ambient = code.replace(
    /(let direct=[\s\S]*)return (vec4f\([^\n]+\));/,
    'if(false){$1_=$2;}return vec4f(i.color,1);',
  );
  assert.ok(balanced(ambient));
  assert.ok(ambient.indexOf('return vec4f(i.color,1);') > ambient.indexOf('i.color=s.color;'));
  engine.dispose();
});

test('detail adds noisy borders, height-blended materials and triplanar stone, and 0 removes them', async () => {
  const shader = async (extra) => {
    const engine = await shaderEngine(),
      mesh = engine.createMesh();
    const colors = new TerrainColors(mesh, { ...options, ...extra });
    engine.use(colors);
    const c = { backend: 'webgpu', shader: wgsl, bindings: [], draw() {} };
    engine.frameGraph.execute(c);
    const id = meshRuntime(mesh).id;
    engine.dispose();
    const start = c.shader.indexOf(`fn terrainSurface_${id}(`);
    return {
      code: c.shader,
      surface: c.shader.slice(start, c.shader.indexOf('\n}', start)),
      look: Array.from(colors.look),
    };
  };
  // Default detail 1: band borders move with the 14 m noise, both blends use material heights, stone is triplanar.
  // (The sand surface is its own test below; it is left out here so the counts are the bands' own.)
  const full = await shader({ sandSurface: false });
  // The meadow band 1 to 10 m wanders by 0.6 of its range (5.4 m); both sit in the look uniform.
  assert.match(
    full.surface,
    /smoothstep\(terrainLook_\d+\[5\]\.x,terrainLook_\d+\[5\]\.y,h\+large\*terrainLook_\d+\[7\]\.x\)/,
  );
  assert.deepEqual([full.look[20], full.look[21], near(full.look[28], 5.4)], [1, 10, true]);
  assert.match(full.surface, /let stoneT=terrainBlend\(steep,grass,/);
  assert.match(full.surface, /let sandT=terrainBlend\(shore,/);
  assert.equal(full.surface.match(/terrainNoise\(/g)?.length, 5);
  assert.match(full.surface, /if\(steep>0\.004&&fade>0\.0\)/);
  assert.match(full.surface, /s\.normal=normalize\(n-\(grad-n\*dot\(n,grad\)\)\*\(0\.15\*stoneT\*sandT\)\);/);
  assert.equal(full.code.match(/fn terrainBlend\(/g)?.length, 1);
  assert.ok(balanced(full.code));
  // Partial detail mixes the plain bands with the height blend and scales the bump.
  const half = await shader({ detail: 0.5, sandSurface: false });
  assert.match(half.surface, /let stoneT=mix\(steep,terrainBlend\(steep,grass,[^;]+\),0\.5\);/);
  assert.match(half.surface, /\(0\.075\*stoneT\*sandT\)/);
  // Detail 0 keeps smooth per-pixel bands: no noise, blend or bump unless variation asks for noise.
  const plain = await shader({ detail: 0 });
  assert.doesNotMatch(plain.code, /terrainNoise|terrainBlend|grad/);
  assert.match(plain.surface, /let stoneT=steep;let sandT=shore;/);
  assert.match(plain.surface, /s\.normal=n;/);
  const varied = await shader({ detail: 0, variation: 0.2 });
  assert.equal(varied.surface.match(/terrainNoise\(/g)?.length, 2);
  assert.match(varied.surface, /\*\(0\.8\+0\.4\*\(0\.65\*large\+0\.35\*fine\)\)/);
  assert.doesNotMatch(varied.code, /terrainBlend\(/);
  const engine = await shaderEngine(),
    mesh = engine.createMesh();
  for (const detail of [-0.1, 1.5, Number.NaN, '1'])
    assert.throws(() => new TerrainColors(mesh, { ...options, detail }), {
      name: 'RangeError',
      message: 'Terrain detail must be a number in 0..1',
    });
  engine.dispose();
});

// KB-TERRAIN-SAND2: sand under TerrainColors was smooth mottled colour. The sand band now carries wind ripples (relief
// clamped out by pixel footprint), streaks along the wind and lee/stoss sorting, on by default; the real-GPU check is
// test/sand.browser.mjs.
test('sand carries wind ripples, streaks and slope sorting by default; false or detail 0 removes them', async () => {
  const looks = [];
  const shader = async (extra) => {
    const engine = await shaderEngine(),
      mesh = engine.createMesh();
    const colors = new TerrainColors(mesh, { ...options, ...extra });
    engine.use(colors);
    const c = { backend: 'webgpu', shader: wgsl, bindings: [], draw() {} };
    engine.frameGraph.execute(c);
    const id = meshRuntime(mesh).id;
    engine.dispose();
    const start = c.shader.indexOf(`fn terrainSurface_${id}(`);
    looks.push(Array.from(colors.look));
    return c.shader.slice(start, c.shader.indexOf('\n}', start));
  };
  const sand = await shader({});
  const values = (look, from, ...want) => want.every((w, i) => near(look[from + i], w));
  // Ripples across the default wind (+x), 10 cm apart, faded between a quarter and half a ripple per pixel: the wind,
  // spacing and relief sit in slot 8 and the fade in slot 10 of the look uniform.
  assert.match(sand, /let sw=terrainLook_\d+\[8\]\.xy;/);
  assert.match(sand, /fract\(along\/terrainLook_\d+\[8\]\.z\+/);
  assert.match(sand, /smoothstep\(terrainLook_\d+\[10\]\.y,terrainLook_\d+\[10\]\.z,foot\)/);
  assert.match(sand, /0\.0966\*up-0\.351\*down/);
  assert.ok(values(looks[0], 32, 1, 0, 0.1, 1));
  assert.ok(values(looks[0], 41, 0.025, 0.05));
  // Slip faces paler, windward faces darker; streaks; all on the sand colour and normal only.
  assert.match(sand, /var sandShade=1\.0\+terrainLook_\d+\[9\]\.x\*lee-terrainLook_\d+\[9\]\.y\*stoss;/);
  assert.match(sand, /sandShade\*=1\.0\+terrainLook_\d+\[9\]\.z\*\(0\.65\*streak\+0\.35\*fineStreak\);/);
  assert.ok(values(looks[0], 36, 0.1, 0.07, 0.16, 0));
  assert.match(sand, /\*sandShade,mix\(meadow/);
  assert.match(sand, /-\(sandGrad-n\*dot\(n,sandGrad\)\)\);/);
  assert.ok(balanced(sand + '\n}'));
  // A wind direction of any length is normalised; spacing and strengths scale their terms.
  const turned = await shader({ sandSurface: { wind: [0, 3], ripple: 0.2, ripples: 2, streaks: 0.5, sorting: 0.5 } });
  assert.ok(values(looks[1], 32, 0, 1, 0.2, 2));
  assert.ok(values(looks[1], 36, 0.05, 0.035, 0.08, 0));
  assert.ok(values(looks[1], 40, 0.07, 0.05, 0.1));
  // The values live in the look uniform, so the turned wind compiles the same shader (only the mesh suffix differs).
  assert.equal(turned.replace(/_\d+/g, '_'), sand.replace(/_\d+/g, '_'));
  // The clamp's footprint is the pixel's own, passed in (KB-TERRAIN-SAND3).
  assert.match(sand, /let foot=footprint;/);
  // Broad scour bands: a term with no distance fade, at strength 0 (the look before the option) unless asked.
  assert.match(sand, /along\*0\.012/);
  assert.equal(looks[0][39], 0);
  const broad = await shader({ sandSurface: { broad: 0.5 } });
  assert.match(
    broad,
    /sandShade\*=1\.0\+terrainLook_\d+\[9\]\.w\*\(terrainNoise\(vec2f\(along\*0\.012,across\*0\.09\)\+vec2f\(23\.0,5\.0\)\)\.x-0\.5\);/,
  );
  assert.ok(near(looks[2][39], 0.15));
  assert.ok(balanced(broad + '\n}'));
  // Off: no trace of it.
  for (const off of [{ sandSurface: false }, { detail: 0 }])
    assert.doesNotMatch(await shader(off), /sandShade|sandGrad|along/);
  const engine = await shaderEngine(),
    mesh = engine.createMesh();
  for (const sandSurface of [
    { wind: [0, 0] },
    { wind: [1] },
    { ripple: 0.01 },
    { ripple: 2 },
    { ripples: 3 },
    { streaks: -1 },
    { sorting: 1.5 },
    { broad: 2 },
    { broad: -0.1 },
  ])
    assert.throws(() => new TerrainColors(mesh, { ...options, sandSurface }), RangeError, JSON.stringify(sandSurface));
  assert.throws(() => new TerrainColors(mesh, { ...options, sandSurface: 'on' }), TypeError);
  engine.dispose();
});

test('wet sand borrows depth through a stable view without moving terrain colors or other meshes', async () => {
  const h = optionalGPU(),
    engine = new Engine({ width: 128, height: 96 }, await TransformStore.create(8), {
      backend: 'webgpu',
      gpu: h.engine.gpu,
      add() {},
      remove() {},
      render() {},
      dispose() {},
    });
  const mesh = engine.createMesh(),
    textures = [0, 1].map(() =>
      h.engine.gpu.createTexture({ size: [4, 4], format: 'rgba32float', usage: GPUTextureUsage.COPY_SRC }),
    );
  let texture;
  const colors = new TerrainColors(mesh, {
    ...options,
    wetness: { texture: () => texture, origin: [-2, -2], size: [4, 4] },
  });
  engine.use(colors);
  const frame = () => {
    h.context.shader = wgsl;
    h.context.bindings = [];
    engine.frameGraph.execute(h.context);
  };
  try {
    frame();
    assert.equal(h.context.bindings[0].resource.texture.format, 'r32float');
    assert.match(h.context.shader, /o.terrainId=i.factors.w\+1.0/);
    assert.match(h.context.shader, new RegExp(`if\\(i.terrainId==${meshRuntime(mesh).id + 1}\\.0\\)`));
    // The wet band darkens the sand albedo per pixel instead of scaling the lit result, and its film smooths it
    // (KB-TERRAIN-WETSAND1: both read the drying record, not the current depth).
    const id = meshRuntime(mesh).id;
    assert.ok(h.context.shader.includes(`let wr=terrainWet_${id}(p);let wet=wr.x;let glint=wr.y;`));
    assert.ok(h.context.shader.includes('s.rough=select(1.0,0.6+terrainLook_' + id + '[2].w*(glint-'));
    assert.match(h.context.shader, /i\.color=s\.color;i\.material\.x\*=s\.rough;n=s\.normal;/);
    assert.doesNotMatch(h.context.shader, /terrainScale/);
    texture = textures[0];
    frame();
    const entry = h.context.bindings[0],
      allocated = { ...h.counts },
      source = colors.wetSource,
      target = colors.wetTarget,
      size = colors.wetSize;
    for (let i = 0; i < 100; i++) {
      texture = textures[i % 2];
      frame();
      assert.equal(h.context.bindings[0], entry);
      assert.equal(colors.wetSource, source);
      assert.equal(colors.wetTarget, target);
      assert.equal(colors.wetSize, size);
    }
    for (const key of ['textures', 'views', 'buffers', 'groups']) assert.equal(h.counts[key], allocated[key]);
    const snapshot = entry.resource.texture;
    colors.onDeviceRestored(engine);
    assert.ok(snapshot.destroyed);
    frame();
    assert.notEqual(h.context.bindings[0].resource.texture, snapshot);
    for (const mutate of [
      (t) => (t.sampleCount = 4),
      (t) => (t.format = 'rgba8unorm'),
      (t) => (t.usage = GPUTextureUsage.TEXTURE_BINDING),
    ]) {
      const bad = { ...textures[0] };
      mutate(bad);
      texture = bad;
      assert.throws(frame, /copyable water-depth/);
    }
    for (const invalid of [null, 0, false]) {
      texture = invalid;
      assert.throws(frame, /copyable water-depth/);
    }
    for (const wetness of [
      null,
      { texture: 0, origin: [0, 0], size: [1, 1] },
      { texture() {}, origin: [NaN, 0], size: [1, 1] },
      { texture() {}, origin: [0, 0], size: [0, 1] },
    ])
      assert.throws(() => new TerrainColors(mesh, { ...options, wetness }), /wetness map/);
  } finally {
    engine.dispose();
    for (const texture of textures) {
      assert.equal(texture.destroyed, false);
      texture.destroy();
    }
    assert.ok(h.resources.every((r) => r.destroyed));
  }
});

test("wet and submerged sand carries no wind ripples: their relief fades with the record's moisture (KB-TERRAIN-SANDWET1)", async () => {
  const h = optionalGPU(),
    engine = new Engine({ width: 128, height: 96 }, await TransformStore.create(8), {
      backend: 'webgpu',
      gpu: h.engine.gpu,
      add() {},
      remove() {},
      render() {},
      dispose() {},
    });
  const wet = engine.createMesh(),
    dry = engine.createMesh();
  engine.use(
    new TerrainColors(wet, { ...options, wetness: { texture: () => undefined, origin: [-2, -2], size: [4, 4] } }),
  );
  engine.use(new TerrainColors(dry, options));
  try {
    h.context.shader = wgsl;
    h.context.bindings = [];
    engine.frameGraph.execute(h.context);
    const shader = h.context.shader,
      body = (mesh) => {
        const start = shader.indexOf(`fn terrainSurface_${meshRuntime(mesh).id}(`);
        return shader.slice(start, shader.indexOf('return s;', start));
      },
      id = meshRuntime(wet).id;
    // The ripple relief is scaled by the dryness of the record, which reads its moisture (x) bilinearly.
    assert.match(body(wet), new RegExp(String.raw`let rv=[^;]*\*\(1\.0-terrainMoisture_${id}\(p\)\);`));
    assert.ok(shader.includes(`fn terrainMoisture_${id}(position:vec3f)->f32 {`));
    assert.match(
      shader,
      new RegExp(String.raw`fn terrainMoisture_${id}[\s\S]*?textureLoad\(terrainWater_${id},hi,0\)\.x,t\.x\)`),
    );
    // Without a wetness record there is no water to wet the sand: the ripples are as before.
    assert.doesNotMatch(body(dry), /terrainMoisture/);
    assert.match(body(dry), /let rv=/);
  } finally {
    engine.dispose();
  }
});

// GAP-FILM-TIME: the wet-sand record dries by the frame clock, never the wall clock. Each frame's update hands the next
// record pass exactly the seconds it stepped, so a film's fixed steps dry the same sand the same way on any machine; a
// capture's zero-delta update and a second view in the frame dry nothing. The record itself is history on the GPU
// (class B, scripts/film-time-reviewed.json): after a cut it rebuilds from the water over the scene's warm-up.
test('the wet-sand record dries by the frame clock: each pass gets exactly the seconds its frames stepped', async () => {
  const h = optionalGPU(),
    engine = new Engine({ width: 128, height: 96 }, await TransformStore.create(8), {
      backend: 'webgpu',
      gpu: h.engine.gpu,
      add() {},
      remove() {},
      render() {},
      dispose() {},
    });
  const mesh = engine.createMesh(),
    texture = h.engine.gpu.createTexture({ size: [4, 4], format: 'rgba32float', usage: GPUTextureUsage.COPY_SRC }),
    colors = new TerrainColors(mesh, {
      ...options,
      wetness: { texture: () => texture, origin: [-2, -2], size: [4, 4] },
    });
  engine.use(colors);
  // One draw of the frame graph, and the drying uniform its record pass was handed: [seconds, dryTime, glossTime, 0].
  const draw = () => {
    h.context.shader = wgsl;
    h.context.bindings = [];
    engine.frameGraph.execute(h.context);
    return [...new Float32Array(colors.dryingBuffer.data.slice(0))];
  };
  const frame = (delta) => {
    colors.onPreUpdate(delta);
    return draw();
  };
  try {
    const step = 1 / 60;
    for (let n = 0; n < 600; n++) assert.deepEqual(frame(step), [Math.fround(step), 900, 20, 0], `frame ${n}`);
    assert.deepEqual(draw(), [0, 900, 20, 0], 'a second view in the frame dries nothing more');
    assert.deepEqual(frame(0), [0, 900, 20, 0], "a capture's zero-delta update dries nothing");
    colors.onPreUpdate(step);
    colors.onPreUpdate(step);
    assert.deepEqual(draw(), [Math.fround(2 * step), 900, 20, 0], 'two updates before one draw dry for both');
  } finally {
    engine.dispose();
    texture.destroy();
  }
});

// 968c88bec: terrainId sat at a fixed @location(6); a struct another patch had already extended declared it twice.
test('terrainId takes the first location the Output struct does not use', async () => {
  const engine = await shaderEngine(),
    mesh = engine.createMesh();
  engine.use(new TerrainColors(mesh, { ...options, variation: 0.1 }));
  const c = {
    backend: 'webgpu',
    shader: wgsl.replace(/struct Output \{[^}]+\}/, (s) => s.replace('}', ',@location(6) other:f32 }')),
    bindings: [],
    draw() {},
  };
  engine.frameGraph.execute(c);
  const output = /struct Output \{[^}]+\}/.exec(c.shader)[0],
    locations = [...output.matchAll(/@location\((\d+)\)/g)].map((m) => Number(m[1]));
  assert.match(output, /@location\(7\) @interpolate\(flat\) terrainId:f32/);
  assert.equal(new Set(locations).size, locations.length, `each varying once: ${locations}`);
  engine.dispose();
});

test('every TerrainColors option has a default, height bands from the mesh under its position and scale (GAP-FILM-LOOK)', async () => {
  const engine = await shaderEngine(),
    mesh = engine.createMesh(),
    bare = engine.createMesh();
  mesh.setGeometry(heightfield((x, z) => x + z, { size: [10, 10], origin: [-1, -1], resolution: 2 }));
  mesh.position.set(0, 1, 0);
  mesh.scale.set(1, 2, 1);
  const SAND = [0.5, 0.42, 0.29],
    MEADOW = [
      [0.133, 0.263, 0.033],
      [0.274, 0.342, 0.064],
    ],
    STONE = [0.253, 0.223, 0.187],
    explicit = (low, high) => ({
      sand: SAND,
      meadow: MEADOW,
      stone: STONE,
      shore: [0.3, 1.5],
      meadowHeight: [low, high],
      stoneHeight: [high + 1, high + 2],
      stoneNormal: [0.75, 0.85],
      wetHeight: [-0.1, 0.4],
      wetDarkening: 0.6,
    });
  // The mesh's heights run from -2 to 18, then y = 1 + 2 h: -3 to 37.
  const look = (c) => Array.from(c.look);
  assert.deepEqual(look(new TerrainColors(mesh)), look(new TerrainColors(mesh, explicit(-3, 37))));
  assert.deepEqual(
    look(new TerrainColors(mesh, { wetDarkening: undefined })),
    look(new TerrainColors(mesh, explicit(-3, 37))),
  );
  assert.deepEqual(
    look(new TerrainColors(bare)),
    look(new TerrainColors(bare, explicit(0, 50))),
    'no geometry yet: 0 to 50 m',
  );
  assert.notDeepEqual(
    look(new TerrainColors(mesh, { sand: [1, 0, 0] })),
    look(new TerrainColors(mesh)),
    'a given option wins',
  );
  assert.equal(new TerrainColors(mesh).surfaceCode, new TerrainColors(mesh, explicit(-3, 37)).surfaceCode);
  const attached = TerrainColors.attach(engine, mesh);
  attached.dispose();
  assert.throws(() => new TerrainColors(mesh, null), TypeError);
});

test('sand the water has left dries over wetDryTime and loses its film over wetGlossTime (KB-TERRAIN-WETSAND1)', () => {
  // Under water and the moment it leaves, the sand is fully wet.
  assert.deepEqual(wetSandAfter(0), { moisture: 1, film: 1, darkening: 1 });
  // One minute on at the defaults (900 s, 20 s): almost all the darkening stays, the sheen is mostly gone.
  const minute = wetSandAfter(60);
  assert.ok(Math.abs(minute.moisture - Math.exp(-60 / 900)) < 1e-12);
  assert.ok(minute.darkening > 0.98 && minute.film < 0.05, JSON.stringify(minute));
  // The darkening share holds while the moisture falls (reflectance levels off toward saturation), then pales.
  const oneTime = wetSandAfter(900);
  assert.ok(oneTime.darkening > oneTime.moisture && oneTime.darkening < 0.75, JSON.stringify(oneTime));
  assert.ok(wetSandAfter(6 * 900).darkening < 0.01);
  for (let t = 0; t < 3600; t += 60) assert.ok(wetSandAfter(t + 60).darkening < wetSandAfter(t).darkening);
  // The drying times are options with checked ranges, and live looks.
  const mesh = { geometry: undefined, scale: { y: 1 }, position: { y: 0 } };
  for (const bad of [{ wetDryTime: 0 }, { wetDryTime: 1e6 }, { wetGlossTime: 0 }, { wetGlossTime: NaN }])
    assert.throws(() => new TerrainColors(mesh, bad), /drying/);
  const colors = new TerrainColors(mesh, { wetDryTime: 120, wetGlossTime: 5 });
  assert.deepEqual([colors.dryTime, colors.glossTime], [120, 5]);
  colors.setLook({ wetDryTime: 30 });
  assert.deepEqual([colors.dryTime, colors.glossTime], [30, 5]);
  assert.throws(() => colors.setLook({ wetGlossTime: 4000 }), /drying/);
});
