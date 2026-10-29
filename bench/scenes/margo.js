// Margo's implementation of every benchmark scene in ./catalog.js. The defaults (WebGPU, 4x MSAA on desktop, DPR 1 in
// the CLI) are what an app gets. Box and part materials are single-sided (doubleSided: false, like other engines'
// default front-side materials): the objects are closed solids, and core draws such batches with a back-culled pipeline.
// Every optional package is imported by the scene that uses it, so a scene's page loads only what that scene needs.
import { Camera, Engine, PbrMaterial, box } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { PART_MATERIALS, LIGHT, PALETTE, SCENES } from './catalog.js';

/** Scenes this engine implements (the page reports any other as unsupported). */
export const scenes = [
  'startup',
  'boxes',
  'shapes',
  'materials',
  'lights',
  'shadows',
  'post',
  'parts',
  'gltf',
  'helmet',
  'react',
  // Data scenes (compute tasks and figures); each is built in ./margo-data.js.
  ...Object.keys(SCENES).filter((id) => SCENES[id].suite === 'data'),
  // Every parity scene (./parity.js); each is built in ./parity/margo-<area>.js.
  ...Object.keys(SCENES).filter((id) => SCENES[id].area),
];
export const meta = { name: 'margo', api: 'webgpu' };

export const single = { doubleSided: false };
export const sceneSamples = () => (/Mobi|Android/.test(navigator.userAgent) ? 1 : 4); // packages/core/src/quality.ts

export async function engineFor(canvas, camera, capacity, marks) {
  const s = performance.now();
  const engine = await Engine.create(canvas, {
    backend: 'webgpu',
    capacity,
    camera: { fov: camera.fov, near: camera.near, far: camera.far, position: camera.at(0), target: camera.target },
  });
  marks.createMs = +(performance.now() - s).toFixed(1);
  const { lighting } = engineRuntime(engine);
  lighting.direction.set([...LIGHT.direction, LIGHT.intensity]);
  lighting.radiance.set([1, 1, 1, LIGHT.ambient]);
  return engine;
}
export const app = (engine, update, extra) => ({
  samples: sceneSamples(),
  render(t) {
    update(t);
    engine.camera.position = extra.camera.at(t);
    if (!extra.views) return engine.render();
    // views: the quarter-turn cameras follow the same orbit.
    extra.views.forEach((view, k) => k && (view.camera.position = extra.camera.at(t + (k * Math.PI) / 2 / 0.3)));
    engine.render({ views: extra.views });
  },
  idle: () => engine.gpu.queue.onSubmittedWorkDone(),
  info: () =>
    extra.draws
      ? { drawCalls: extra.draws, note: `${extra.draws} instanced draws, not counted by core` }
      : { drawCalls: engine.stats.drawCalls, note: extra.note ?? 'core batches (package passes not counted)' },
});
/** Four views, one per quarter of the canvas: the engine camera, then three more cameras on its orbit. */
export const quarters = (engine, camera) =>
  [0, 1, 2, 3].map((k) => ({
    camera: k
      ? new Camera({
          fov: camera.fov,
          near: camera.near,
          far: camera.far,
          position: camera.at(0),
          target: camera.target,
        })
      : engine.camera,
    viewport: [(k % 2) * 0.5, (k >> 1) * 0.5, 0.5, 0.5],
  }));
export const linear = (hex) =>
  [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
// Column-major world matrix from position + Euler XYZ (as core's setRotation), times the parent's.
export async function composer() {
  const { Matrix4, Euler, Quaternion, Vector3 } = await import('@margoengine/math'),
    one = new Vector3(1, 1, 1),
    q = new Quaternion(),
    e = new Euler(),
    p = new Vector3();
  return (position, rotation, parent, m = new Matrix4()) => {
    m.compose(p.set(...position), q.setFromEuler(e.set(...rotation)), one);
    return parent ? m.premultiply(parent) : m;
  };
}
// Per-frame form for moving boxes: the item's matrix with its y rotation replaced, without allocating (as other engines'
// implementations compose theirs).
async function mover() {
  const { Matrix4, Euler, Quaternion, Vector3 } = await import('@margoengine/math'),
    one = new Vector3(1, 1, 1),
    q = new Quaternion(),
    e = new Euler(),
    p = new Vector3(),
    m = new Matrix4();
  return (item, ry) => {
    const a = item.position,
      r = item.rotation;
    return m.compose(p.set(a[0], a[1], a[2]), q.setFromEuler(e.set(r[0], ry, r[2])), one).elements;
  };
}
/** Core meshes for a list of {position, rotation, color | material} items; returns the meshes. */
export function meshes(engine, def, materials) {
  const geometry = box(def.size, def.size, def.size);
  return def.items.map((b) =>
    engine
      .createMesh()
      .setGeometry(geometry)
      .setMaterial(materials[b.material ?? b.color])
      .setPosition(b.position)
      .setRotation(b.rotation),
  );
}
export const palette = (def) => PALETTE.map((color) => new PbrMaterial({ color, ...def.material, ...single }));
export const floor = (engine, f) =>
  engine
    .createMesh()
    .setGeometry(box(...f.size))
    .setPosition(f.position)
    .setMaterial(new PbrMaterial({ color: f.color, roughness: f.roughness, metalness: 0 }));

const builders = {
  async startup(canvas, data, marks) {
    // The smallest app path: core + stage, one lit box.
    const s = performance.now(),
      { createStage } = await import('margoengine'),
      { camera } = data;
    const stage = await createStage(canvas, {
      backend: 'webgpu',
      autoStart: false,
      controls: false,
      camera: { fov: camera.fov, near: camera.near, far: camera.far, position: camera.at(0), target: camera.target },
    });
    marks.createMs = +(performance.now() - s).toFixed(1);
    stage.box({ color: data.color, size: [data.size, data.size, data.size] });
    marks.buildMs = 0;
    return app(stage.engine, () => {}, { camera });
  },

  async boxes(canvas, data, marks, { n, mode, move, views = 1 }) {
    if (views !== 1 && (views !== 4 || mode === 'instanced'))
      throw new RangeError(`boxes views=${views}: 1, or 4 with mode=mesh`);
    if (mode === 'instanced') return instancedBoxes(canvas, data, marks, { n, move });
    if (mode === 'culled') return culledBoxes(canvas, data, marks, { n, move });
    const engine = await engineFor(canvas, data.camera, n + 8, marks),
      s = performance.now(),
      list = meshes(engine, data, palette(data));
    marks.buildMs = +(performance.now() - s).toFixed(1);
    const moving = move ? n : 0;
    return app(
      engine,
      (t) => {
        for (let i = 0; i < moving; i++) list[i].rotation.y = data.items[i].rotation[1] + t;
      },
      { camera: data.camera, views: views === 4 ? quarters(engine, data.camera) : undefined },
    );
  },

  async shapes(canvas, data, marks, { n, mode }) {
    if (mode !== 'mesh' && mode !== 'batched') throw new RangeError(`shapes mode=${mode}: mesh or batched`);
    const engine = await engineFor(canvas, data.camera, n + 8, marks),
      s = performance.now();
    floor(engine, data.floor);
    if (mode === 'mesh') {
      const materials = palette(data);
      for (const b of data.items)
        engine
          .createMesh()
          .setGeometry(box(...b.size))
          .setMaterial(materials[b.color])
          .setPosition(b.position)
          .setRotation(b.rotation);
      marks.buildMs = +(performance.now() - s).toFixed(1);
      return app(engine, () => {}, { camera: data.camera });
    }
    const at = await composer(),
      [{ Material }, { BatchedMesh }, { boxGeometry }] = await Promise.all([
        import('@margoengine/materials'),
        import('@margoengine/materials/batched'),
        import('@margoengine/geometry'),
      ]);
    const batch = BatchedMesh.attach(engine, new Material({ color: '#ffffff', ...data.material, ...single }), {
      maxItems: n,
      maxVertices: n * 24,
      maxIndices: n * 36,
    });
    for (const b of data.items)
      batch.add(boxGeometry(...b.size), {
        matrix: at(b.position, b.rotation).elements,
        color: linear(PALETTE[b.color]),
      });
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(engine, () => {}, { camera: data.camera, draws: 2 });
  },

  async materials(canvas, data, marks, { n }) {
    const engine = await engineFor(canvas, data.camera, n + 8, marks),
      s = performance.now();
    meshes(
      engine,
      data,
      data.materials.map((m) => new PbrMaterial({ ...m, ...single })),
    );
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(engine, () => {}, { camera: data.camera });
  },

  async lights(canvas, data, marks, { n }) {
    const engine = await engineFor(canvas, data.camera, n + 8, marks),
      s = performance.now(),
      { Clustered } = await import('@margoengine/clustered');
    floor(engine, data.floor);
    meshes(engine, data, palette(data));
    const lights = Clustered.attach(engine),
      set = (t) =>
        lights.setLights(
          data.lights.map((l) => ({ position: l.at(t), range: l.range, color: l.color, intensity: l.intensity })),
        );
    set(0);
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(engine, set, { camera: data.camera, note: 'core batches; clustered light passes not counted' });
  },

  async shadows(canvas, data, marks, { n }) {
    const engine = await engineFor(canvas, data.camera, n + 8, marks),
      s = performance.now(),
      { Shadows } = await import('@margoengine/shadows');
    const shadows = Shadows.attach(engine, { resolution: data.resolution, distance: data.extent * 2 });
    shadows.add(floor(engine, data.floor), { static: true });
    for (const mesh of meshes(engine, data, palette(data))) shadows.add(mesh);
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(engine, () => {}, { camera: data.camera, note: 'core batches; shadow passes not counted' });
  },

  async post(canvas, data, marks, { n }) {
    const engine = await engineFor(canvas, data.camera, n + 8, marks),
      s = performance.now();
    const [{ PostStack }, { SSAO }, { Bloom }, { FXAA }, { Tonemap }] = await Promise.all([
      import('@margoengine/post/stack'),
      import('@margoengine/post/ssao'),
      import('@margoengine/post/bloom'),
      import('@margoengine/post/fxaa'),
      import('@margoengine/tonemap'),
    ]);
    floor(engine, data.floor);
    meshes(engine, data, palette(data));
    PostStack.attach(engine, [new SSAO(), new Bloom({ strength: 0.6 }), new Tonemap({ curve: 'neutral' }), new FXAA()]);
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(engine, () => {}, { camera: data.camera, note: 'core batches; post passes not counted' });
  },

  async parts(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, data.nodes.length + 8, marks),
      s = performance.now(),
      { toGeometry } = await import('@margoengine/geometry');
    const geometries = Object.fromEntries(Object.entries(data.shapes).map(([k, v]) => [k, toGeometry(v)])),
      materials = Object.fromEntries(
        Object.entries(PART_MATERIALS).map(([k, v]) => [k, new PbrMaterial({ ...v, ...single })]),
      );
    const list = [];
    for (const node of data.nodes) {
      const mesh = engine
        .createMesh(node.parent < 0 ? undefined : list[node.parent])
        .setPosition(node.position)
        .setRotation(node.rotation);
      if (node.shape) mesh.setGeometry(geometries[node.shape]).setMaterial(materials[node.shape]);
      list.push(mesh);
    }
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(engine, () => {}, { camera: data.camera });
  },

  async gltf(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, 4096, marks),
      s = performance.now(),
      { loadGLTF } = await import('@margoengine/gltf-pro');
    await loadGLTF(engine, data.url);
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(engine, () => {}, { camera: data.camera, note: 'engine.stats.drawCalls (gltf-pro draws included)' });
  },

  async helmet(canvas, data, marks) {
    const engine = await engineFor(canvas, data.camera, 1024, marks),
      s = performance.now();
    const [{ loadGLTF }, { Environment, EnvironmentLighting }, { Shadows }] = await Promise.all([
      import('@margoengine/gltf-pro'),
      import('@margoengine/environment'),
      import('@margoengine/shadows'),
    ]);
    floor(engine, data.floor);
    const model = await loadGLTF(engine, data.url);
    const environment = await Environment.create(engine, data.sky);
    engine.use(environment);
    const ibl = new EnvironmentLighting(environment);
    engine.use(ibl);
    ibl.applyTo(model);
    Shadows.attach(engine, {
      resolution: data.shadow.resolution,
      distance: 10,
      filter: data.filter,
      cascades: data.cascades,
    }).add(model);
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(engine, () => {}, {
      camera: data.camera,
      note: `core batches (package passes not counted); shadows: ${data.cascades} cascade(s) of 2048, ${data.filter === 'pcf' ? "'pcf' filter (4 comparison taps)" : "the default 'soft' PCSS filter (16 blocker reads, 32 taps)"}`,
    });
  },

  async react(canvas, data, marks, { n }) {
    // @margoengine/react: <Canvas> owns its canvas, so the harness canvas is hidden and the React one takes its place.
    const [{ createElement: h }, { createRoot }, { flushSync }, R] = await Promise.all([
      import('react'),
      import('react-dom/client'),
      import('react-dom'),
      import('@margoengine/react'),
    ]);
    canvas.style.display = 'none';
    const host = document.createElement('div');
    host.style.cssText = 'width:1280px;height:720px';
    canvas.after(host);
    const { camera, items, size, material } = data,
      s = performance.now();
    let ready;
    const created = new Promise((r) => (ready = r));
    const scene = (t) =>
      h(
        R.Canvas,
        {
          style: { width: '1280px', height: '720px' },
          backend: 'webgpu',
          capacity: n + 16,
          frameloop: 'demand',
          camera: {
            fov: camera.fov,
            near: camera.near,
            far: camera.far,
            position: camera.at(0),
            target: camera.target,
          },
          onCreated: ready,
        },
        items.map((b, i) =>
          h(
            R.Mesh,
            { key: i, position: b.position, rotation: [0, b.rotation[1] + t, 0] },
            h(R.BoxGeometry, { args: [size, size, size] }),
            h(R.PbrMaterial, { color: PALETTE[b.color], ...material }),
          ),
        ),
      );
    const root = createRoot(host);
    flushSync(() => root.render(scene(0)));
    const stage = await created,
      engine = stage.engine;
    marks.createMs = +(performance.now() - s).toFixed(1);
    while (engine.meshes.size < n) await new Promise((r) => requestAnimationFrame(r));
    marks.buildMs = +(performance.now() - s).toFixed(1);
    const { lighting } = engineRuntime(engine);
    lighting.direction.set([...LIGHT.direction, LIGHT.intensity]);
    lighting.radiance.set([1, 1, 1, LIGHT.ambient]);
    return {
      ...app(engine, (t) => flushSync(() => root.render(scene(t))), { camera }),
      info: () => ({ drawCalls: engine.stats.drawCalls, meshes: engine.meshes.size }),
    };
  },
};

async function instancedBoxes(canvas, data, marks, { n, move }) {
  // @margoengine/materials createInstancedMesh: one batch, the palette as a per-instance tint.
  const engine = await engineFor(canvas, data.camera, 64, marks),
    s = performance.now(),
    at = await composer();
  const [{ createInstancedMesh, Material }, { boxGeometry }] = await Promise.all([
    import('@margoengine/materials'),
    import('@margoengine/geometry'),
  ]);
  const mesh = createInstancedMesh(
    engine,
    boxGeometry(data.size, data.size, data.size),
    new Material({ color: '#ffffff', ...data.material, ...single }),
    n,
  );
  data.items.forEach((b, i) => {
    mesh.instances.setMatrixAt(i, at(b.position, b.rotation).elements);
    mesh.instances.setColorAt(i, linear(PALETTE[b.color]));
  });
  marks.buildMs = +(performance.now() - s).toFixed(1);
  const turn = await mover(),
    moving = move ? n : 0;
  return app(
    engine,
    (t) => {
      for (let i = 0; i < moving; i++)
        mesh.instances.setMatrixAt(i, turn(data.items[i], data.items[i].rotation[1] + t));
    },
    { camera: data.camera, draws: 1 },
  );
}

async function culledBoxes(canvas, data, marks, { n, move }) {
  // @margoengine/culling CulledInstances: one batch per palette colour (core's box and PbrMaterial), GPU frustum culling.
  const engine = await engineFor(canvas, data.camera, 64, marks),
    s = performance.now(),
    at = await composer(),
    { CulledInstances } = await import('@margoengine/culling'),
    geometry = box(data.size, data.size, data.size),
    materials = palette(data),
    slots = data.items.map(() => 0),
    counts = materials.map(() => 0);
  data.items.forEach((b, i) => (slots[i] = counts[b.color]++));
  const transforms = counts.map((c) => new Float32Array(c * 16));
  data.items.forEach((b, i) => transforms[b.color].set(at(b.position, b.rotation).elements, slots[i] * 16));
  const parts = CulledInstances.attach(
    engine,
    materials
      .map((material, k) => ({ geometry, material, transforms: transforms[k] }))
      .filter((b) => b.transforms.length),
  );
  // Batch index per colour (colours without boxes have no batch).
  const batchOf = counts.map((_, k) => counts.slice(0, k).filter(Boolean).length);
  marks.buildMs = +(performance.now() - s).toFixed(1);
  const turn = await mover(),
    moving = move ? n : 0;
  return app(
    engine,
    (t) => {
      for (let i = 0; i < moving; i++) {
        const b = data.items[i];
        parts.setTransform(batchOf[b.color], slots[i], turn(b, b.rotation[1] + t));
      }
    },
    { camera: data.camera, draws: parts.starts.length },
  );
}

/** Builds `scene` from the catalog's engine-neutral `data` (harness.js calls this). */
export async function create(canvas, { scene, params, data }, marks) {
  // Parity scenes (./parity.js) are built in ./parity/margo-<area>.js, loaded only for the scene that runs.
  const area = SCENES[scene]?.area,
    build =
      builders[scene] ||
      (SCENES[scene]?.suite === 'data' && (await import('./margo-data.js')).builders[scene]) ||
      (area && (await import(`./parity/margo-${area}.js`)).builders[scene]);
  if (!build) throw new Error(`margo: no implementation of scene ${scene}`);
  return build(canvas, data, marks, params);
}
