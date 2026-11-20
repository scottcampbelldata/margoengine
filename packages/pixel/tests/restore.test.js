// KB-RESTORE-BORROWED1 for @margoengine/pixel (docs/conventions.md, "Borrowed GPU objects"). A plain source or target
// texture (PixelScale, CRT, PaletteQuantize) and a plain Render3D target belong to the device they were given on. After a
// device restore the pass binds nothing of the old device, reports it once through engine.onError ('state', help
// borrowed-lost) and draws nothing (Render3D: puts the picture in its own `output`), and `setSource` and `setTarget` bring a
// new texture back. A function is a per-frame getter (rule 6): read every frame, never reported.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CRT } from '../dist/crt.js';
import { PixelScale } from '../dist/scale.js';
import { PaletteQuantize } from '../dist/palette.js';
import { Render3D } from '../dist/render3d.js';

globalThis.GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8 };
globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 4, COPY_DST: 2, COPY_SRC: 1, RENDER_ATTACHMENT: 16 };

const texture = (owner, format = 'rgba8unorm', width = 8, height = 4) => {
  const t = { owner, format, width, height, destroy() {}, createView: () => ({ texture: t }) };
  return t;
};

function device(tag) {
  const d = {
    tag,
    groups: [],
    features: new Set(),
    createShaderModule: () => ({}),
    createRenderPipeline: () => {
      const layout = {};
      return { getBindGroupLayout: () => layout };
    },
    createBuffer: () => ({ destroy() {} }),
    createBindGroup: (group) => (d.groups.push(group), group),
    createTexture: (descriptor) => texture(d, descriptor.format ?? 'rgba8unorm', descriptor.size[0], descriptor.size[1]),
    queue: { writeBuffer() {}, writeTexture() {} },
  };
  return d;
}

function setup() {
  const first = device('first'),
    second = device('second'),
    errors = [],
    passes = new Map(),
    draws = [],
    engine = {
      backend: 'webgpu',
      gpu: first,
      onError: (e) => errors.push(e),
      frameGraph: { add: (pass) => passes.set(pass.name, pass) },
      sceneOf: () => undefined,
      removePlugin() {},
    },
    encoder = {
      copyTextureToTexture() {},
      beginRenderPass: (descriptor) => {
        const entry = { target: descriptor.colorAttachments[0].view?.texture };
        return {
          setPipeline() {},
          setBindGroup: (_, g) => (entry.group = g),
          setScissorRect() {},
          draw: () => draws.push(entry),
          end() {},
        };
      },
    },
    run = (name) =>
      passes.get(name).execute({
        backend: 'webgpu',
        device: engine.gpu,
        encoder,
        format: 'rgba8unorm',
        descriptor: {},
        color: { texture: texture(engine.gpu), createView: () => ({ texture: texture(engine.gpu) }) },
        width: 8,
        height: 4,
        view: undefined,
      });
  return {
    first,
    second,
    errors,
    draws,
    engine,
    run,
    lost: () => errors.filter((e) => /borrowed-lost/.test(e.message)),
    restore(pass) {
      engine.gpu = second;
      pass.onDeviceRestored?.(engine);
    },
    /** Every texture the bind groups of device `d` bind. */
    bound: (d) => d.groups.flatMap((g) => g.entries.map((e) => e.resource.texture).filter(Boolean)),
  };
}

for (const [label, Pass] of [
  ['PixelScale', PixelScale],
  ['CRT', CRT],
]) {
  test(`${label}: a plain source and target lost with the device are reported once and nothing of them is bound`, () => {
    const s = setup(),
      source = texture(s.first),
      target = texture(s.first),
      pass = new Pass({ source, target });
    pass.setup(s.engine);
    s.run(pass.name);
    assert.equal(s.draws.length, 1);
    assert.equal(s.draws[0].target, target);
    s.restore(pass);
    s.run(pass.name);
    s.run(pass.name);
    assert.equal(s.draws.length, 1, 'nothing is drawn while the texture is lost');
    assert.equal(s.bound(s.second).length, 0, 'no bind group of the new device holds an old texture');
    assert.equal(s.lost().length, 2, 'one report for the source and one for the target');
    assert.match(s.lost()[0].message, /source.*setSource/);
    assert.match(s.lost()[1].message, /target.*setTarget/);
    assert.equal(s.lost()[0].code, 'state');
    const newSource = texture(s.second),
      newTarget = texture(s.second);
    pass.setSource(newSource);
    pass.setTarget(newTarget);
    s.run(pass.name);
    assert.equal(s.draws.length, 2);
    assert.equal(s.draws[1].target, newTarget);
    assert.deepEqual(s.bound(s.second), [newSource]);
    assert.equal(s.lost().length, 2, 'no new report');
    pass.dispose();
  });

  test(`${label}: a function source and target are read every frame and need nothing at a restore`, () => {
    const s = setup();
    let source = texture(s.first),
      target = texture(s.first);
    const pass = new Pass({ source: () => source, target: () => target });
    pass.setup(s.engine);
    s.run(pass.name);
    s.restore(pass);
    source = texture(s.second);
    target = texture(s.second);
    s.run(pass.name);
    assert.equal(s.draws.length, 2);
    assert.equal(s.draws[1].target, target);
    assert.deepEqual(s.lost(), []);
    pass.dispose();
  });

  test(`${label}: a plain source with no target draws over the canvas and is held by the same rule`, () => {
    const s = setup(),
      pass = new Pass({ source: texture(s.first) });
    pass.setup(s.engine);
    s.run(pass.name);
    s.restore(pass);
    s.run(pass.name);
    assert.equal(s.draws.length, 1);
    assert.equal(s.lost().length, 1);
    const fresh = texture(s.second);
    pass.setSource(fresh);
    s.run(pass.name);
    assert.equal(s.draws.length, 2);
    assert.deepEqual(s.bound(s.second), [fresh]);
    pass.dispose();
  });
}

const palette = [
  [0, 0, 0],
  [1, 1, 1],
];

test('PaletteQuantize: a plain source and target lost with the device are reported once, a setter brings them back', () => {
  const s = setup(),
    pass = new PaletteQuantize({ palette, source: texture(s.first), target: texture(s.first) });
  pass.setup(s.engine);
  s.run(pass.name);
  assert.equal(s.draws.length, 1);
  s.restore(pass);
  s.run(pass.name);
  s.run(pass.name);
  assert.equal(s.draws.length, 1, 'nothing is drawn while the texture is lost');
  assert.equal(s.second.groups.length, 0, 'no bind group is made on the new device with an old texture');
  assert.equal(s.lost().length, 2);
  assert.match(s.lost()[0].message, /PaletteQuantize source.*setSource/);
  assert.match(s.lost()[1].message, /PaletteQuantize target.*setTarget/);
  const source = texture(s.second),
    target = texture(s.second);
  pass.setSource(source);
  pass.setTarget(target);
  s.run(pass.name);
  assert.equal(s.draws.length, 2);
  assert.equal(s.draws[1].target, target);
  assert.ok(s.bound(s.second).includes(source));
  assert.equal(s.lost().length, 2);
  assert.throws(() => pass.setSource(undefined), TypeError);
  pass.dispose();
});

test('PaletteQuantize: function textures are read every frame and never reported', () => {
  const s = setup();
  let source = texture(s.first),
    target = texture(s.first);
  const pass = new PaletteQuantize({ palette, source: () => source, target: () => target });
  pass.setup(s.engine);
  s.run(pass.name);
  s.restore(pass);
  source = texture(s.second);
  target = texture(s.second);
  s.run(pass.name);
  assert.equal(s.draws.length, 2);
  assert.deepEqual(s.lost(), []);
  pass.dispose();
});

test('Render3D: a plain target lost with the device is reported once and the picture goes to its own output until setTarget', () => {
  const s = setup(),
    camera = { position: [0, 0, 5], target: [0, 0, 0] },
    target = texture(s.first, 'rgba8unorm', 8, 4),
    render = new Render3D({ camera, width: 8, height: 4, target, outline: false });
  render.setup(s.engine);
  assert.equal(render.output, target);
  s.restore(render);
  const own = render.output;
  assert.equal(own.owner, s.second, 'the picture goes to a texture of the new device');
  assert.notEqual(own, target);
  assert.equal(render.output, own);
  assert.equal(s.lost().length, 1);
  assert.match(s.lost()[0].message, /Render3D target.*setTarget/);
  assert.equal(s.lost()[0].code, 'state');
  const fresh = texture(s.second, 'rgba8unorm', 8, 4);
  render.setTarget(fresh);
  assert.equal(render.output, fresh);
  assert.equal(s.lost().length, 1);
  render.setTarget(undefined);
  assert.equal(render.output.owner, s.second);
  render.dispose();
});

test('Render3D: a function target is read every frame and never reported', () => {
  const s = setup();
  let target = texture(s.first, 'rgba8unorm', 8, 4);
  const render = new Render3D({
    camera: { position: [0, 0, 5], target: [0, 0, 0] },
    width: 8,
    height: 4,
    target: () => target,
  });
  render.setup(s.engine);
  assert.equal(render.output, target);
  s.restore(render);
  target = texture(s.second, 'rgba8unorm', 8, 4);
  assert.equal(render.output, target);
  assert.deepEqual(s.lost(), []);
  render.dispose();
});
