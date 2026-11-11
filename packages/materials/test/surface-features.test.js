// Parallax, triplanar and subsurface on createMesh meshes, recorded on a mock device: the shader text each adds (and
// that it adds none while unused), its bindings and live uniform. browser-check.mjs checks the rendered values on a
// real adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { wgsl } from '../../core/dist/shaders.js';
import { Shadows } from '../../shadows/dist/index.js';
import {
  LambertMaterial,
  Material,
  PbrMaterial,
  PhongMaterial,
  Texture,
  UnlitMaterial,
  createInstancedMesh,
  createMesh,
} from '../dist/index.js';

async function scene() {
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
  const view = context(gpu, { samples: 1, format: 'bgra8unorm', depthFormat: 'depth32float', shader: wgsl });
  let n = 0;
  const history = [],
    frame = () => {
      const log = gpu.record(() => {
        store.tick(false);
        view.begin(n++);
        engine.frameGraph.execute(view.c);
      });
      history.push(...log);
      return log;
    };
  return { gpu, engine, frame, history };
}
const quad = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  uvs: [0, 0, 1, 0, 1, 1, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
};
const codes = (log) => log.filter((e) => e[0] === 'module').map((e) => e[2].code);
const bindings = (log) => log.filter((e) => e[0] === 'group').map((e) => e[2].entries.map((entry) => entry.binding));
const floats = (hex) => new Float32Array(Uint8Array.from(Buffer.from(hex, 'hex')).buffer);
/** The surface uniform (binding 170) writes in `log`, as numbers; `history` holds the frames that bound the buffers. */
const surfaceWrites = (log, history) => {
  const ids = new Set(
    history
      .filter((e) => e[0] === 'group')
      .flatMap((e) => e[2].entries.filter((entry) => entry.binding === 170).map((entry) => entry.resource.buffer)),
  );
  return log.filter((e) => e[0] === 'writeBuffer' && ids.has(e[1])).map((e) => [...floats(e[3])]);
};
const solid = (r, g = r, b = r) =>
  new Texture(
    { data: new Uint8Array([r, g, b, 255, r, g, b, 255, r, g, b, 255, r, g, b, 255]), width: 2, height: 2 },
    { mipmaps: false },
  );
/** GPU calls of one frame drawing `material` on a fresh mock device, cast into a directional shadow map. */
async function oneFrame(material) {
  const s = await scene(),
    mesh = createMesh(s.engine, quad, material),
    shadows = Shadows.attach(s.engine, { resolution: 256, cascades: 1 });
  shadows.add(mesh);
  const log = s.frame();
  s.engine.removePlugin(shadows.name);
  mesh.destroy();
  s.engine.dispose();
  return log;
}
const defaults = {
  parallaxMap: null,
  parallaxScale: 0.05,
  parallaxMode: 'occlusion',
  parallaxSteps: 16,
  triplanar: false,
  triplanarScale: 1,
  triplanarSharpness: 4,
  subsurface: 0,
  subsurfaceMode: 'thick',
  subsurfaceColor: [1, 1, 1],
  subsurfaceThickness: 0.5,
  subsurfaceThicknessMap: null,
  subsurfaceDistortion: 0.2,
  subsurfacePower: 4,
  subsurfaceWrap: 0.5,
};

test('every surface option at its default, or turned off again, draws exactly the GPU calls of a plain material', async () => {
  const material = new PbrMaterial({ map: solid(90) });
  for (const [key, value] of Object.entries(defaults))
    assert.deepEqual(material[key], value, `${key} defaults to ${JSON.stringify(value)}`);
  const expected = await oneFrame(new PbrMaterial({ map: solid(90) }));
  assert.deepEqual(await oneFrame(new PbrMaterial({ map: solid(90), ...defaults })), expected);
  const toggled = new PbrMaterial({
    map: solid(90),
    parallaxMap: solid(0),
    parallaxScale: 0.2,
    parallaxMode: 'relief',
    parallaxSteps: 8,
    triplanar: true,
    triplanarScale: 3,
    subsurface: 1,
    subsurfaceMode: 'thin',
    subsurfaceThicknessMap: solid(10),
  });
  Object.assign(toggled, { parallaxMap: null, triplanar: false, subsurface: 0 });
  assert.deepEqual(await oneFrame(toggled), expected, 'a feature turned off, values left set, adds nothing');
  assert.ok(codes(expected).every((c) => !c.includes('margoSurface')));
});

test('parallaxMap marches the view ray at bindings 170-172; scale, steps, mode and its UV rows are live', async () => {
  const s = await scene(),
    material = new PbrMaterial({ map: solid(90), parallaxMap: solid(0), parallaxScale: 0.25 }),
    mesh = createMesh(s.engine, quad, material);
  let log = s.frame();
  const code = codes(log).find((c) => c.includes('fn margoParallax('));
  assert.ok(code, 'the parallax shader');
  assert.ok(
    code.includes('fn margoParallaxSurface(i:Out,front:bool)->Surface {') &&
      code.includes(
        'fn surface(i:Out,front:bool)->Surface {\n  return margoParallaxSurface(margoParallax(i),front);\n}',
      ),
    'surface() reads every map at the marched UVs',
  );
  assert.ok(!code.includes('margoThicknessMap') && !code.includes('fn margoPlanarSurface('), 'only parallax');
  assert.ok(bindings(log).some((list) => [170, 171, 172].every((b) => list.includes(b)) && !list.includes(173)));
  let values = surfaceWrites(log, s.history).at(-1);
  assert.deepEqual(values.slice(0, 4), [0.25, 16, 1, 0]);
  material.parallaxSteps = 32;
  material.parallaxMode = 'relief';
  material.setUVTransform({ offset: [0.5, 0], scale: [2, 2] }, 'parallaxMap');
  log = s.frame();
  assert.deepEqual(codes(log), [], 'live values compile nothing');
  values = surfaceWrites(log, s.history).at(-1);
  assert.deepEqual(values.slice(0, 4), [0.25, 32, 2, 0]);
  assert.deepEqual(
    values.slice(4, 12).map((v) => v + 0),
    [2, 0, 0.5, 0, 0, 2, 0, 0],
    'its own UV rows',
  );
  material.parallaxMode = 'offset';
  assert.equal(surfaceWrites(s.frame(), s.history).at(-1)[2], 0);
  assert.equal(surfaceWrites(s.frame(), s.history).length, 0, 'a steady material writes nothing again');
  for (const [key, value, kind] of [
    ['parallaxScale', -1, RangeError],
    ['parallaxScale', '1', TypeError],
    ['parallaxSteps', 0, RangeError],
    ['parallaxSteps', 2.5, RangeError],
    ['parallaxSteps', 65, RangeError],
    ['parallaxMode', 'steep', TypeError],
    ['parallaxMap', {}, TypeError],
  ])
    assert.throws(() => (material[key] = value), kind, `${key} = ${value}`);
  material.parallaxMap = null;
  log = s.frame();
  assert.ok(
    bindings(log).every((list) => !list.includes(170)),
    'removed live',
  );
  mesh.destroy();
  s.engine.dispose();
});

test('triplanar blends three world projections of surface() by the normal; UV1 is kept; scale and sharpness are live', async () => {
  const s = await scene(),
    material = new PbrMaterial({ map: solid(90), normalMap: solid(128, 128, 255), clearcoat: 0.5, triplanar: true }),
    mesh = createMesh(s.engine, quad, material);
  let log = s.frame();
  const code = codes(log).find((c) => c.includes('fn margoPlanarSurface('));
  assert.ok(code, 'the triplanar shader');
  for (const projection of [
    'o.uv=vec4f(-side.x*p.z,p.y,i.uv.zw);',
    'o.uv=vec4f(p.x,-side.y*p.z,i.uv.zw);',
    'o.uv=vec4f(side.z*p.x,p.y,i.uv.zw);',
  ])
    assert.ok(code.includes(projection), projection);
  assert.ok(code.includes('o.tangent=vec4f(0);'), 'each projection derives its own normal-map frame');
  assert.ok(code.includes('s.n=normalize(a.n*w.x+b.n*w.y+c.n*w.z);'), 'the blended normal is renormalised');
  assert.ok(code.includes('s.cn=normalize(a.cn*w.x+b.cn*w.y+c.cn*w.z);'), 'every Surface field, physical ones too');
  assert.ok(bindings(log).some((list) => list.includes(170) && !list.includes(171)));
  material.triplanarScale = 2.5;
  material.triplanarSharpness = 8;
  assert.deepEqual(surfaceWrites(s.frame(), s.history).at(-1).slice(12, 16), [2.5, 8, 0, 0]);
  for (const [key, value, kind] of [
    ['triplanarScale', 0, RangeError],
    ['triplanarSharpness', 0.5, RangeError],
    ['triplanar', 1, TypeError],
  ])
    assert.throws(() => (material[key] = value), kind, `${key} = ${value}`);
  mesh.destroy();
  // Instanced meshes project in world space too (after the instance matrix).
  const instanced = createInstancedMesh(s.engine, quad, new UnlitMaterial({ map: solid(9), triplanar: true }), 2);
  log = s.frame();
  assert.ok(codes(log).some((c) => c.includes('fn margoPlanarSurface(') && c.includes('o.mirror=margoS;')));
  instanced.destroy();
  s.engine.dispose();
});

test('subsurface adds the wrap to the directional light and the translucency after it; standard, Lambert and Phong only', async () => {
  const s = await scene(),
    material = new LambertMaterial({ map: solid(188), subsurface: 0.75, subsurfaceColor: '#ff0000' }),
    mesh = createMesh(s.engine, quad, material);
  let log = s.frame();
  const code = codes(log).find((c) => c.includes('fn margoSubsurface('));
  assert.ok(code.includes('let direct=direct_light(s,v,l)+margoSubsurfaceWrap(s,l);'), 'the wrap is shadowed with it');
  assert.ok(code.includes('var color=margoSubsurface(i,s,v,l)+'), 'the translucency is added unshadowed');
  assert.ok(code.includes('fn margoThickness(i:Out)->f32 {return 1.0;}'), 'no thickness map, no binding');
  assert.ok(
    code.includes('fn surface(i:Out,front:bool)->Surface {\n  _=margoSurface;'),
    'auxiliary entries keep the layout',
  );
  assert.ok(bindings(log).some((list) => list.includes(170) && !list.includes(173)));
  let values = surfaceWrites(log, s.history).at(-1);
  assert.deepEqual(values.slice(16, 25), [0.75, 0, Math.fround(0.2), 4, 1, 0, 0, 0.5, 0.5]);
  material.subsurfaceThicknessMap = solid(20);
  material.subsurfaceMode = 'thin';
  material.subsurfaceThickness = 0.25;
  log = s.frame();
  assert.ok(codes(log).some((c) => c.includes('textureSample(margoThicknessMap,margoThicknessSampler,')));
  assert.ok(bindings(log).some((list) => [170, 173, 174].every((b) => list.includes(b))));
  values = surfaceWrites(log, s.history).at(-1);
  assert.deepEqual([values[17], values[23]], [1, 0.25]);
  for (const [key, value, kind] of [
    ['subsurface', 2, RangeError],
    ['subsurfaceMode', 'skin', TypeError],
    ['subsurfacePower', 0, RangeError],
    ['subsurfaceDistortion', -1, RangeError],
    ['subsurfaceWrap', 1.5, RangeError],
    ['subsurfaceThicknessMap', 'thick.png', TypeError],
  ])
    assert.throws(() => (material[key] = value), kind, `${key} = ${value}`);
  assert.throws(() => new UnlitMaterial({ subsurface: 1 }), TypeError);
  assert.throws(() => new Material({ shading: 'toon', subsurface: 1 }), /standard, lambert or phong/);
  assert.equal(new Material({ shading: 'toon', subsurface: 0 }).subsurface, 0, 'zero is allowed anywhere');
  mesh.destroy();
  // Phong and standard (with the shadows hook wrapping the direct term) compose the same edits.
  for (const other of [new PhongMaterial({ subsurface: 1 }), new PbrMaterial({ subsurface: 1, roughness: 0.5 })]) {
    const lit = codes(await oneFrame(other)).find((c) => c.includes('fn margoSubsurface('));
    assert.ok(
      lit.includes('var color=margoSubsurface(i,s,v,l)+shadowLit(direct,i.position,s.n)+ambient(s)+s.emissive;'),
      other.shading,
    );
  }
  s.engine.dispose();
});

test('clone and copy carry the surface options and share their maps', () => {
  const map = solid(5),
    source = new PbrMaterial({
      parallaxMap: map,
      parallaxScale: 0.3,
      triplanar: true,
      subsurface: 0.4,
      subsurfaceColor: [0.5, 0.25, 1],
    });
  source.setUVTransform({ scale: [4, 4] }, 'subsurfaceThicknessMap');
  const copy = source.clone(),
    target = new PbrMaterial().copy(source);
  for (const m of [copy, target]) {
    assert.equal(m.parallaxMap, map);
    assert.deepEqual([m.parallaxScale, m.triplanar, m.subsurface, m.subsurfaceColor], [0.3, true, 0.4, [0.5, 0.25, 1]]);
  }
  copy.parallaxScale = 0.1;
  assert.equal(source.parallaxScale, 0.3, 'independent values');
  assert.throws(() => source.setUVTransform({}, 'heightMap'), TypeError);
});
