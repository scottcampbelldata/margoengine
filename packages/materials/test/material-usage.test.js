// three.js-style live material use on createMesh meshes: swapping mesh.material, with what it keeps and frees.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { wgsl } from '../../core/dist/shaders.js';
import { Skeleton, Skin } from '../../animation/dist/index.js';
import { Material, PhongMaterial, Texture, UnlitMaterial, createMesh } from '../dist/index.js';

async function scene({ depthFormat = 'depth32float' } = {}) {
  const gpu = mockGPU(),
    store = await TransformStore.create(64),
    renderer = { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} };
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    store,
    renderer,
    { position: [0, 0, 6], target: [0, 0, 0] },
    null,
  );
  engine.camera.update(4 / 3, true);
  const view = context(gpu, { samples: 1, format: 'bgra8unorm', depthFormat, shader: wgsl });
  let n = 0;
  const frame = () =>
    gpu.record(() => {
      store.tick(false);
      view.begin(n++);
      engine.frameGraph.execute(view.c);
    });
  return { gpu, engine, frame, id: (value) => gpu.snap(value), record: (work) => gpu.record(work) };
}
const of = (log, name) => log.filter((e) => e[0] === name);
const codes = (log) => of(log, 'module').map((e) => e[2].code);
const floats = (hex) => new Float32Array(Uint8Array.from(Buffer.from(hex, 'hex')).buffer);
// Buffers created in `log` with the size of a Phong uniform (specular rgb + shininess).
const phongBuffers = (log) => of(log, 'buffer').filter((e) => e[2].size === 16 && e[2].usage & GPUBufferUsage.UNIFORM);
// Two quads side by side, one group each.
const quads = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 3, 1, 0, 2, 1, 0],
  normals: Array.from({ length: 8 }, () => [0, 0, 1]).flat(),
  uvs: Array.from({ length: 2 }, () => [0, 0, 1, 0, 1, 1, 0, 1]).flat(),
  indices: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7],
  groups: [
    { start: 0, count: 6, materialIndex: 0 },
    { start: 6, count: 6, materialIndex: 1 },
  ],
};
const quad = { ...quads, groups: undefined };

test('mesh.material = other draws the new material next frame and moves per-engine uniforms between materials', async () => {
  const s = await scene();
  const red = new PhongMaterial({ color: [1, 0, 0] }),
    blue = new PhongMaterial({ color: [0, 0, 1], shininess: 8 }),
    mesh = createMesh(s.engine, quad, red),
    other = createMesh(s.engine, quad, red);
  let log = s.frame();
  const [redBuffer] = phongBuffers(log);
  assert.equal(phongBuffers(log).length, 1, 'meshes sharing a material share its uniform');
  mesh.material = blue;
  assert.equal(mesh.material, blue);
  assert.equal(mesh.primitives[0].material.base, blue.color, 'gltf-pro reads the new material');
  log = s.frame();
  const [blueBuffer] = phongBuffers(log);
  assert.ok(blueBuffer, 'the new material gets its uniform on first draw');
  const phong = of(log, 'writeBuffer').filter((e) => e[1] === blueBuffer[1]);
  assert.deepEqual([...floats(phong[0][3])], [...blue.specular, 8].map(Math.fround));
  // The beauty uniform carries the new base colour (floats 76-79).
  const frames = of(log, 'writeBuffer')
    .filter((e) => e[3].length === 880 * 2)
    .map((e) => [...floats(e[3]).slice(76, 80)]);
  assert.ok(frames.some((v) => v.join() === '0,0,1,1'));
  assert.ok(
    frames.some((v) => v.join() === '1,0,0,1'),
    'the other mesh keeps the old one',
  );
  assert.equal(of(log, 'renderPipeline').length, 0, 'the same shading reuses its pipeline');
  log = s.record(() => {
    other.material = new UnlitMaterial({ color: [0, 1, 0] });
  });
  assert.deepEqual(of(log, 'destroy'), [['destroy', redBuffer[1]]], 'the last use of a material frees its uniform');
  log = s.frame();
  assert.ok(
    codes(log).some((c) => c.includes('mat_out(')),
    'a different shading compiles its own pipeline',
  );
  log = s.record(() => mesh.dispose());
  assert.deepEqual(
    of(log, 'destroy').filter((e) => e[1] === blueBuffer[1]),
    [['destroy', blueBuffer[1]]],
    'disposing the mesh releases the swapped-in material',
  );
  s.engine.dispose();
});

test('a swap keeps the model, its lighting registrations, picking and sorting live', async () => {
  const s = await scene();
  const order = [],
    track = (name, m) => {
      const draw = m.draw.bind(m);
      m.draw = (...args) => {
        order.push(name);
        return draw(...args);
      };
      return m;
    };
  const first = track('first', createMesh(s.engine, quad, new Material()));
  track('second', createMesh(s.engine, quad, new Material(), { renderOrder: 1 }));
  first.addLighting({ shader: (code) => code + '\n// registered effect', bindings: () => [] });
  s.frame();
  assert.deepEqual(order, ['first', 'second']);
  first.material = new Material({ transparent: true, opacity: 0.5, side: 'back', shading: 'lambert' });
  order.length = 0;
  const log = s.frame();
  assert.deepEqual(order, ['second', 'first'], 'a transparent material draws after opaque meshes');
  assert.ok(s.engine.hasPlugin(first.name));
  assert.ok(
    codes(log).some((c) => c.includes('// registered effect') && c.includes('fn margoFront(')),
    'the model keeps its effect, now on the Lambert shader',
  );
  assert.equal(first.pickingPrimitives[0].side, 'back');
  assert.equal(first.pickingPrimitives[0].cutoff, 0.001, 'blended picking cutoff');
  s.engine.dispose();
});

test('grouped meshes swap the whole material array; invalid assignments throw and change nothing', async () => {
  const s = await scene();
  const a = new Material({ color: [1, 0, 0] }),
    b = new Material({ color: [0, 1, 0] }),
    c = new Material({ color: [0, 0, 1] }),
    mesh = createMesh(s.engine, quads, [a, b]),
    single = createMesh(s.engine, quad, a);
  assert.deepEqual(mesh.material, [a, b]);
  assert.ok(Object.isFrozen(mesh.material));
  mesh.material = [c, a];
  assert.deepEqual(mesh.material, [c, a]);
  assert.ok(Object.isFrozen(mesh.material));
  assert.deepEqual(
    mesh.primitives.map((p) => p.material.base),
    [c.color, a.color],
  );
  for (const [target, value, message] of [
    [mesh, a, /array of 2 Materials/],
    [mesh, [a], /array of 2 Materials/],
    [mesh, [a, {}], /array of 2 Materials/],
    [single, [a], /one Material/],
    [single, null, /one Material/],
  ])
    assert.throws(
      () => {
        target.material = value;
      },
      { name: 'TypeError', message },
    );
  assert.deepEqual(mesh.material, [c, a]);
  assert.equal(single.material, a);
  s.frame();
  single.dispose();
  assert.throws(
    () => {
      single.material = b;
    },
    { name: 'MargoError', code: 'disposed' },
  );
  s.engine.dispose();
});

test('a skinned mesh stays skinned across a material swap', async () => {
  const s = await scene(),
    mesh = createMesh(s.engine, quad, new Material()),
    skeleton = new Skeleton([
      { name: 'root', parent: -1 },
      { name: 'tip', parent: 0, translation: [0, 1, 0] },
    ]),
    skin = Skin.attach(mesh, skeleton, new Array(32).fill(0), new Array(32).fill(1));
  const deformed = mesh.primitives[0].deformed;
  mesh.material = new PhongMaterial({ color: '#ff8800' });
  assert.equal(mesh.primitives[0].deformed, deformed);
  assert.equal(typeof mesh.prepareDeformation, 'function');
  const log = s.frame();
  assert.ok(
    of(log, 'pass.setVertexBuffer').some((e) => e[1] === 0 && e[2] === s.id(deformed)),
    'the swapped material draws the deformed vertices',
  );
  assert.ok(codes(log).some((c) => c.includes('mat_phong')));
  skin.dispose();
  s.engine.dispose();
});

test('swapping between extended physical materials recompiles gltf-pro for the new lobes', async () => {
  const s = await scene(),
    mesh = createMesh(s.engine, quad, new Material({ iridescence: 1 }));
  let log = s.frame();
  assert.ok(codes(log).some((c) => c.includes('fn margoIridescence(')));
  mesh.material = new Material({ anisotropy: 1 });
  log = s.frame();
  const fresh = codes(log);
  assert.ok(fresh.some((c) => c.includes('fn margoAnisotropy(')));
  assert.ok(!fresh.some((c) => c.includes('fn margoIridescence(')), 'the old plan is not reused');
  mesh.material = new Material();
  log = s.frame();
  assert.ok(
    of(log, 'writeBuffer').some((e) => e[3].length === 880 * 2),
    'back to the standard uniform layout',
  );
  s.engine.dispose();
});

test('colours take set(input) and assignment with hex strings, 0xrrggbb numbers and linear arrays, live', async () => {
  const s = await scene(),
    m = new PhongMaterial({ color: 0xff8000, opacity: 0.5 }),
    mesh = createMesh(s.engine, quad, m),
    color = m.color;
  assert.deepEqual(new Material({ color: 0xff8000 }).color, new Material({ color: '#ff8000' }).color);
  assert.deepEqual(m.color.set('#00f'), [0, 0, 1, 0.5], 'hex keeps opacity');
  m.color = 0x00ff00;
  assert.equal(m.color, color, 'assignment writes into the live array');
  assert.deepEqual(m.color, [0, 1, 0, 0.5]);
  m.color.set([0.1, 0.2, 0.3]);
  assert.deepEqual(m.color, [0.1, 0.2, 0.3, 0.5]);
  m.color = [0, 0, 1, 1];
  assert.equal(m.opacity, 1, 'a four-component array sets opacity too');
  m.emissive.set(0x808080);
  assert.ok(Math.abs(m.emissive[0] - 0.2158605) < 1e-6, 'numbers are sRGB');
  m.emissive = '#000';
  m.specular = 0xffffff;
  assert.deepEqual([...m.emissive, ...m.specular], [0, 0, 0, 1, 1, 1]);
  m.color[1] = 0.25; // element writes keep working
  assert.equal(mesh.primitives[0].material.base, color);
  const log = s.frame(),
    frame = of(log, 'writeBuffer').find((e) => e[3].length === 880 * 2);
  assert.deepEqual([...floats(frame[3]).slice(76, 80)], [0, 0.25, 1, 1]);
  const phong = phongBuffers(log)[0];
  assert.deepEqual(
    [...floats(of(log, 'writeBuffer').find((e) => e[1] === phong[1])[3])],
    [1, 1, 1, 30],
    'Phong reads the assigned specular',
  );
  // Every colour option takes numbers.
  const glass = new Material({
    sheenColor: 0xffffff,
    specularColor: 0x000000,
    attenuationColor: 0x808080,
    transmission: 1,
  });
  assert.deepEqual(
    [glass.sheenColor, glass.specularColor],
    [
      [1, 1, 1],
      [0, 0, 0],
    ],
  );
  glass.sheenColor = 0x000000;
  assert.deepEqual(glass.sheenColor, [0, 0, 0]);
  assert.ok(Math.abs(glass.attenuationColor[0] - 0.2158605) < 1e-6);
  for (const [value, name] of [
    [0x1000000, 'RangeError'],
    [1.5, 'RangeError'],
    [-1, 'RangeError'],
    ['red', 'TypeError'],
    ['#ff00', 'TypeError'],
    [[1, 1], 'TypeError'],
    [[2, 0, 0], 'RangeError'],
  ]) {
    assert.throws(() => new Material({ color: value }), { name, message: /material color/i });
    assert.throws(() => m.color.set(value), { name });
  }
  assert.deepEqual(m.color, [0, 0.25, 1, 1], 'a rejected colour changes nothing');
  s.engine.dispose();
});

test('render state set after createMesh selects the matching pipeline next frame, and back', async () => {
  const s = await scene(),
    m = new Material(),
    mesh = createMesh(s.engine, quad, m),
    beauty = (log) => of(log, 'renderPipeline').filter((e) => e[2].fragment?.entryPoint === 'fragment'),
    bound = (log) => of(log, 'pass.setPipeline').map((e) => e[1]);
  const [plain] = beauty(s.frame());
  m.blending = 'additive';
  m.depthWrite = false;
  m.colorWrite = false;
  assert.equal(m.customState, true);
  assert.equal(mesh.primitives[0].material.renderState.depthWrite, false);
  let log = s.frame();
  let [made] = beauty(log);
  assert.equal(made[2].fragment.targets[0].blend.color.dstFactor, 'one', 'additive');
  assert.equal(made[2].fragment.targets[0].writeMask, 0, 'colorWrite false');
  assert.equal(made[2].depthStencil.depthWriteEnabled, false);
  m.polygonOffset = true;
  m.polygonOffsetFactor = 2;
  m.polygonOffsetUnits = 3;
  [made] = beauty(s.frame());
  assert.deepEqual(
    [made[2].depthStencil.depthBias, made[2].depthStencil.depthBiasSlopeScale],
    [-3, -2],
    'away from the camera in reverse-Z',
  );
  Object.assign(m, { blending: 'normal', depthWrite: undefined, colorWrite: true, polygonOffset: false });
  assert.equal(mesh.primitives[0].material.renderState, undefined);
  log = s.frame();
  assert.equal(beauty(log).length, 0, 'the default state reuses the first pipeline');
  assert.ok(bound(log).includes(plain[1]));
  m.wireframe = true;
  log = s.frame();
  assert.equal(beauty(log)[0][2].primitive.topology, 'line-list', 'wireframe is live too');
  mesh.primitives[0].material.wireframe = false;
  assert.equal(m.wireframe, false, 'the native flag writes the material');
  for (const [key, value, name] of [
    ['blending', 'screen', 'TypeError'],
    ['depthTest', 1, 'TypeError'],
    ['depthWrite', null, 'TypeError'],
    ['wireframe', 'yes', 'TypeError'],
    ['polygonOffsetUnits', 0.5, 'RangeError'],
    ['polygonOffsetFactor', Infinity, 'RangeError'],
    ['stencilRef', -1, 'RangeError'],
    ['stencilFunc', 'lesser', 'TypeError'],
    ['stencilZPass', 'increment', 'TypeError'],
  ]) {
    const before = m[key];
    assert.throws(
      () => {
        m[key] = value;
      },
      { name, message: new RegExp('Material ' + key + '.*; set') },
    );
    assert.equal(m[key], before, key + ' unchanged');
  }
  s.engine.dispose();
});

test('a live stencil reference keeps its pipeline; other stencil state picks a new one', async () => {
  const s = await scene({ depthFormat: 'depth24plus-stencil8' }),
    m = new Material({ stencilWrite: true, stencilRef: 1, stencilZPass: 'replace' });
  createMesh(s.engine, quad, m);
  s.frame();
  m.stencilRef = 2;
  let log = s.frame();
  assert.equal(of(log, 'renderPipeline').length, 0);
  assert.ok(of(log, 'pass.setStencilReference').some((e) => e[1] === 2));
  m.stencilFunc = 'equal';
  log = s.frame();
  assert.equal(of(log, 'renderPipeline')[0][2].depthStencil.stencilFront.compare, 'equal');
  s.engine.dispose();
});

test('clone() is an independent copy of the same class that shares only textures', async () => {
  const s = await scene(),
    map = new Texture({ data: new Uint8Array(16), width: 2, height: 2 }, { mipmaps: false }),
    m = new PhongMaterial({ color: '#ff8000', map, shininess: 12, blending: 'additive', side: 'back' });
  m.setUVTransform({ offset: [0.5, 0] });
  const c = m.clone();
  assert.ok(c instanceof PhongMaterial && c !== m);
  assert.deepEqual(
    [c.shading, c.color, c.shininess, c.blending, c.side, c.uvt],
    [m.shading, m.color, m.shininess, m.blending, m.side, m.uvt],
  );
  assert.equal(c.map, map, 'textures are shared');
  assert.notEqual(c.color, m.color);
  c.color.set(0x0000ff);
  c.roughness = 0.2;
  c.blending = 'normal';
  c.setUVTransform(null);
  assert.deepEqual(
    [m.color[2], m.roughness, m.blending, m.uvt[2]],
    [0, 1, 'additive', 0.5],
    'the original is untouched',
  );
  // Each draws with its own uniform.
  createMesh(s.engine, quad, m);
  createMesh(s.engine, quad, c);
  assert.equal(phongBuffers(s.frame()).length, 2);
  const glass = new Material({ transmission: 1, thickness: 0.5, iridescence: 0.5 }).clone();
  glass.thickness = 2;
  assert.deepEqual([glass.transmissive, glass.thickness, glass.extensions.includes('iridescence')], [true, 2, true]);
  s.engine.dispose();
});

test('copy(source) writes every value into this material in place; meshes show it next frame', async () => {
  const s = await scene(),
    target = new Material(),
    color = target.color,
    mesh = createMesh(s.engine, quad, target),
    map = new Texture({ data: new Uint8Array(16), width: 2, height: 2 }, { mipmaps: false });
  s.frame();
  const source = new Material({ color: [0, 0, 1], roughness: 0.3, transparent: true, opacity: 0.5, map, clearcoat: 1 });
  assert.equal(target.copy(source), target);
  assert.equal(target.color, color, 'same live array');
  assert.deepEqual(
    [target.color, target.roughness, target.transparent, target.map, target.clearcoat],
    [[0, 0, 1, 0.5], 0.3, true, map, 1],
  );
  source.color.set(0xff0000);
  assert.equal(target.color[0], 0, 'no link to the source afterwards');
  const log = s.frame(),
    frame = of(log, 'writeBuffer').find((e) => e[3].length === 880 * 2);
  assert.deepEqual([...floats(frame[3]).slice(76, 80)], [0, 0, 1, 0.5]);
  assert.equal(mesh.primitives[0].material.settings[0], 2, 'now blended');
  assert.throws(() => target.copy(new Material({ shading: 'phong' })), { name: 'TypeError', message: /same shading/ });
  assert.throws(() => target.copy({}), TypeError);
  s.engine.dispose();
});

test('dispose() frees what no mesh uses and refuses later meshes; live meshes keep drawing', async () => {
  const s = await scene(),
    map = new Texture({ data: new Uint8Array(16), width: 2, height: 2 }, { mipmaps: false }),
    m = new PhongMaterial({ map }),
    mesh = createMesh(s.engine, quad, m);
  const [owned] = phongBuffers(s.frame());
  // A uniform made outside any mesh (no engine owner) has no user.
  const loose = m.bindings(s.gpu.device).find((e) => e.binding === 197).resource.buffer;
  let log = s.record(() => m.dispose());
  assert.deepEqual(
    of(log, 'destroy'),
    [['destroy', s.id(loose)]],
    'only the unused uniform goes: textures and mesh uniforms stay',
  );
  log = s.frame();
  assert.ok(of(log, 'pass.drawIndexed').length > 0, 'the mesh still draws');
  assert.throws(() => createMesh(s.engine, quad, m), { name: 'MargoError', code: 'disposed' });
  assert.throws(
    () => {
      createMesh(s.engine, quad, new Material()).material = m;
    },
    { name: 'MargoError', code: 'disposed' },
  );
  assert.throws(() => m.copy(new PhongMaterial()), { name: 'MargoError', code: 'disposed' });
  const again = m.clone();
  assert.doesNotThrow(() => createMesh(s.engine, quad, again), 'a clone of a disposed material is usable');
  log = s.record(() => mesh.dispose());
  assert.ok(
    of(log, 'destroy').some((e) => e[1] === owned[1]),
    'its last mesh releases the engine uniform',
  );
  s.engine.dispose();
});
