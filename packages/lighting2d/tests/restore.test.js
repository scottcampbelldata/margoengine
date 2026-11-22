// KB-RESTORE-BORROWED1 for @margoengine/lighting2d (docs/conventions.md, "Borrowed GPU objects"), and the steady-frame
// work of every 2D lighting pass. A plain target, normals, painted source or emission belongs to the device it was
// given on: after a device restore the pass binds nothing of the old device, reports it once through engine.onError
// and keeps drawing what it can (no target: the pass is skipped; no normals: flat; no painted source: GI without the
// painted scene; no emission: the source, as when emission is left out), and a setter brings it back. A function is
// a per-frame getter (rule 6) and is never reported. A steady frame makes no bind group and no texture view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Lighting2D, Light2D } from '../dist/index.js';
import { CookieLighting2D } from '../dist/cookie.js';
import { SoftLighting2D } from '../dist/soft.js';
import { EmissiveLighting2D } from '../dist/emissive.js';
import { HeightLighting2D, HeightLight2D } from '../dist/height.js';
import { GILighting2D } from '../dist/gi.js';
import { SDFScene2D } from '../dist/sdf.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

/** One fake device with what the 2D passes call; `textures` are the caller's, made on it. */
function gpu() {
  const h = optionalGPU(),
    d = h.engine.gpu,
    make = d.createTexture;
  d.limits.minUniformBufferOffsetAlignment = 256;
  d.createPipelineLayout = (descriptor) => descriptor;
  d.createTexture = (descriptor) => Object.assign(make(descriptor), { depthOrArrayLayers: descriptor.size[2] ?? 1 });
  return {
    ...h,
    texture: (width = 16, height = 8) =>
      d.createTexture({ size: [width, height], format: 'rgba8unorm', usage: 0x1f, label: 'caller' }),
  };
}

/** An engine on `first` that records reports and the render passes it begins; `restore` moves it to a new device. */
function engineOn(first) {
  const errors = [],
    passes = [],
    { engine, context } = first,
    begin = context.encoder.beginRenderPass;
  engine.onError = (error) => errors.push(error);
  context.encoder.beginRenderPass = (descriptor) => {
    passes.push(descriptor);
    return Object.assign(begin(descriptor), { setStencilReference() {} });
  };
  return {
    engine,
    errors,
    passes,
    // Each frame records into a new encoder, as a real frame does (SDFScene2D encodes once per encoder).
    frame() {
      context.encoder = { ...context.encoder };
      first.frame();
    },
    lost: () => errors.filter((e) => /borrowed-lost/.test(e.message)),
    restore(next) {
      engine.gpu = context.device = next.engine.gpu;
      for (const plugin of engine.plugins.values()) plugin.onDeviceRestored?.(engine);
    },
    /** The textures this frame's passes wrote to. */
    written: (from) => passes.slice(from).flatMap((p) => p.colorAttachments.map((a) => a.view?.texture)),
  };
}

const kinds = [
  {
    name: 'Lighting2D',
    normals: true,
    make: (o) => {
      const p = new Lighting2D({ ...o, occluders: [{ shape: 'segment', from: [4, 0], to: [4, 8] }] });
      p.addLight({ x: 2, y: 4, radius: 32 });
      return p;
    },
  },
  {
    name: 'CookieLighting2D',
    normals: true,
    make: (o) => {
      const p = new CookieLighting2D({ ...o, occluders: [{ shape: 'segment', from: [4, 0], to: [4, 8] }] });
      p.addLight({ x: 2, y: 4, radius: 32 });
      return p;
    },
  },
  {
    name: 'SoftLighting2D',
    normals: true,
    make: (o) => {
      const p = new SoftLighting2D({ ...o, occluders: [{ shape: 'segment', from: [4, 0], to: [4, 8] }] });
      p.addLight({ x: 2, y: 4, radius: 32 });
      return p;
    },
  },
  {
    name: 'EmissiveLighting2D',
    make: (o) => new EmissiveLighting2D({ ...o, sprites: [{ x: 4, y: 4, radius: 2 }] }),
  },
  {
    name: 'HeightLighting2D',
    make: (o) =>
      new HeightLighting2D({
        ...o,
        lights: [new HeightLight2D({ x: 2, y: 4, radius: 32 }), new HeightLight2D({ x: 12, y: 2, radius: 32 })],
        occluders: [{ shape: 'box', height: 4, width: 2, depth: 2, offset: [6, 4] }],
      }),
  },
  {
    name: 'GILighting2D',
    make: (o) =>
      new GILighting2D({
        ...o,
        lights: [new Light2D({ x: 2, y: 4, radius: 32 })],
        occluders: [{ shape: 'segment', from: [4, 0], to: [4, 8] }],
        cascades: { cascades: 2, bounces: 1 },
      }),
  },
];

for (const kind of kinds)
  test(`${kind.name}: a steady frame makes no bind group and no texture view`, () => {
    const first = gpu(),
      e = engineOn(first),
      target = first.texture(),
      normals = kind.normals ? first.texture() : undefined,
      pass = kind.make({ target: () => target, ...(normals ? { normals: () => normals } : {}) });
    first.engine.use(pass);
    e.frame();
    e.frame();
    const groups = first.counts.groups,
      views = first.counts.views,
      from = e.passes.length;
    for (let i = 0; i < 3; i++) e.frame();
    assert.ok(e.written(from).includes(target), 'the pass draws into its target');
    assert.equal(first.counts.groups - groups, 0, 'bind groups made by three steady frames');
    assert.equal(first.counts.views - views, 0, 'texture views made by three steady frames');
    // A new target is a new view (and the groups that bind it), once.
    const bigger = first.texture(32, 16),
      biggerNormals = first.texture(32, 16);
    pass.setTarget(() => bigger);
    if (normals) pass.setNormals(() => biggerNormals);
    e.frame();
    const after = first.counts.views;
    e.frame();
    assert.equal(first.counts.views, after, 'the new target view is kept');
    assert.deepEqual(e.errors, []);
    pass.dispose();
  });

test('GILighting2D with a painted scene: a steady frame makes no bind group and no texture view', () => {
  const first = gpu(),
    e = engineOn(first),
    target = first.texture(),
    painted = new SDFScene2D({ source: first.texture(), emission: first.texture() }),
    pass = kinds.at(-1).make({ target, painted });
  first.engine.use(pass);
  e.frame();
  e.frame();
  const groups = first.counts.groups,
    views = first.counts.views;
  for (let i = 0; i < 3; i++) e.frame();
  assert.equal(first.counts.groups - groups, 0, 'bind groups made by three steady frames');
  assert.equal(first.counts.views - views, 0, 'texture views made by three steady frames');
  pass.dispose();
  painted.dispose();
});

for (const kind of kinds)
  test(`${kind.name}: a plain target lost at a device restore skips the pass, is reported once, and setTarget brings it back`, () => {
    const first = gpu(),
      second = gpu(),
      e = engineOn(first),
      target = first.texture(),
      pass = kind.make({ target });
    first.engine.use(pass);
    e.frame();
    assert.ok(e.written(0).includes(target));
    e.restore(second);
    const from = e.passes.length,
      made = second.counts.groups;
    e.frame();
    e.frame();
    assert.ok(!e.written(from).includes(target), 'nothing is drawn into the lost target');
    assert.equal(second.counts.groups, made, 'nothing is bound for a pass with no target');
    assert.equal(e.lost().length, 1, 'one report');
    assert.match(
      e.lost()[0].message,
      new RegExp(`^${kind.name} target lost with the device; pass a function or call setTarget`),
    );
    assert.equal(e.lost()[0].code, 'state');
    // A new texture through the setter, given from the caller's own restore hook (engine.gpu is the new device).
    const again = second.texture();
    pass.setTarget(again);
    const back = e.passes.length;
    e.frame();
    assert.ok(e.written(back).includes(again), 'the pass draws into the new target');
    assert.equal(e.lost().length, 1, 'no further report');
    // A function is read every frame: across the next restore it gives the third device's texture, with no report.
    const third = gpu();
    let current = again;
    pass.setTarget(() => current);
    e.frame();
    e.restore(third);
    current = third.texture();
    const last = e.passes.length;
    e.frame();
    assert.ok(e.written(last).includes(current));
    assert.equal(e.lost().length, 1, 'a function target is never reported');
    pass.dispose();
  });

for (const kind of kinds.filter((k) => k.normals))
  test(`${kind.name}: plain normals lost at a device restore draw flat, are reported once, and setNormals brings them back`, () => {
    const first = gpu(),
      second = gpu(),
      e = engineOn(first),
      pass = kind.make({ target: () => e.engine.gpu.target, normals: first.texture() });
    first.engine.gpu.target = first.texture();
    second.engine.gpu.target = second.texture();
    first.engine.use(pass);
    e.frame();
    const old = new Set(first.resources);
    e.restore(second);
    e.frame();
    e.frame();
    const bound = second.groups.flatMap((g) => g.entries.map((x) => x.resource?.texture ?? x.resource?.buffer));
    assert.deepEqual(
      bound.filter((r) => old.has(r)),
      [],
      'nothing of the old device is bound',
    );
    assert.ok(e.written(0).includes(second.engine.gpu.target), 'the light still reaches the target, flat');
    assert.equal(e.lost().length, 1, 'one report');
    assert.match(
      e.lost()[0].message,
      new RegExp(`^${kind.name} normals lost with the device; pass a function or call setNormals`),
    );
    const normals = second.texture();
    pass.setNormals(normals);
    e.frame();
    assert.ok(
      second.groups.some((g) => g.entries.some((x) => x.binding === 1 && x.resource?.texture === normals)),
      'the new normals are bound',
    );
    assert.equal(e.lost().length, 1);
    pass.dispose();
  });

test('SDFScene2D: a lost painted source leaves the painted scene out of GI, a lost emission falls back to the source, each reported once', () => {
  const first = gpu(),
    second = gpu(),
    e = engineOn(first),
    painted = new SDFScene2D({ source: first.texture(), emission: first.texture() }),
    pass = new GILighting2D({ target: () => e.engine.gpu.target, painted, cascades: { cascades: 2, bounces: 1 } });
  first.engine.gpu.target = first.texture();
  second.engine.gpu.target = second.texture();
  first.engine.use(pass);
  const paints = (h) => h.pipelines.some((p) => (p.compute ?? p.vertex)?.module?.code?.includes('tracePaint('));
  e.frame();
  assert.ok(paints(first), 'GI traces the painted scene');
  e.restore(second);
  e.frame();
  e.frame();
  assert.ok(e.written(0).includes(second.engine.gpu.target), 'GI still lights the target');
  assert.ok(!paints(second), 'without the painted scene on the new device');
  const old = new Set(first.resources),
    bound = second.groups.flatMap((g) => g.entries.map((x) => x.resource?.texture ?? x.resource?.buffer));
  assert.deepEqual(
    bound.filter((r) => old.has(r)),
    [],
    'nothing of the old device is bound',
  );
  assert.deepEqual(
    e.lost().map((x) => x.message.split(';')[0]),
    ['SDFScene2D source lost with the device'],
  );
  assert.match(e.lost()[0].message, /pass a function or call assign a new source/);
  // A new source, assigned from the caller's restore hook: painted again, and the lost emission falls back to it.
  const source = second.texture();
  painted.source = source;
  e.frame();
  assert.ok(paints(second), 'GI traces the painted scene again');
  const encode = () => second.groups.filter((g) => g.entries.some((x) => x.binding === 8)).at(-1);
  assert.equal(encode().entries.find((x) => x.binding === 6).resource.texture, source, 'the emission is the source');
  assert.deepEqual(
    e.lost().map((x) => x.message.split(';')[0]),
    ['SDFScene2D source lost with the device', 'SDFScene2D emission lost with the device'],
  );
  const emission = second.texture();
  painted.emission = emission;
  e.frame();
  assert.equal(encode().entries.find((x) => x.binding === 6).resource.texture, emission, 'the new emission is bound');
  assert.equal(e.lost().length, 2, 'no further report');
  // Functions are read every frame and survive the next restore with no report.
  const third = gpu();
  third.engine.gpu.target = third.texture();
  painted.source = () => e.engine.gpu.source;
  painted.emission = undefined;
  e.restore(third);
  third.engine.gpu.source = third.texture();
  e.frame();
  assert.ok(paints(third));
  assert.equal(e.lost().length, 2);
  assert.throws(() => (painted.source = undefined), TypeError);
  pass.dispose();
  painted.dispose();
});
