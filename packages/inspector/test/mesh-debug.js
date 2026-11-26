// The page of test/mesh-debug-browser.mjs: one camera whose meshes each scenario replaces.
import { Engine, Geometry, PbrMaterial } from '../../core/dist/index.js';
import { sphereGeometry } from '../../geometry/dist/index.js';
import { createMesh, createInstancedMesh, UnlitMaterial } from '../../materials/dist/index.js';
import { MeshDebugView } from '../dist/mesh-debug.js';
import { setGeometrySurface } from '../../shared/mesh-source.js';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const errors = [];
addEventListener('error', (e) => errors.push(e.message));
addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
const engine = await Engine.create(document.querySelector('canvas'), { backend: 'webgpu' });
engine.onError = (e) => errors.push(String(e.message ?? e));
// A narrow lens straight down -z: the plane z 0 spans -1..1 across the canvas, almost without perspective.
engine.camera.fov = 10;
engine.camera.position = [0, 0, 1 / Math.tan((5 * Math.PI) / 180)];
engine.camera.target = [0, 0, 0];
engine.camera.far = 100;

// A square of side 1.5 in the xy plane facing +z, two triangles whose diagonal runs bottom-left to top-right.
const square = (half = 0.75, x = 0) => ({
  positions: [x - half, -half, 0, x + half, -half, 0, x + half, half, 0, x - half, half, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  uvs: [0, 0, 1, 0, 1, 1, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
});
const coreMesh = (data, { uv = false, doubleSided = true } = {}) => {
  const geometry = new Geometry(data.positions, data.normals, data.indices);
  if (uv) setGeometrySurface(geometry, { uv: new Float32Array(data.uvs) });
  return engine
    .createMesh()
    .setGeometry(geometry)
    .setMaterial(new PbrMaterial({ color: '#ff0000', doubleSided }));
};
const matrix = (sx, x) => [sx, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
const scenes = {
  core: () => [coreMesh(square())],
  coreUv: () => [coreMesh(square(), { uv: true })],
  sphere: () => [coreMesh(sphereGeometry(0.8, 48, 24))],
  // A one-sided square turned away from the camera.
  back: () => {
    const mesh = coreMesh(square(), { doubleSided: false });
    mesh.setRotation([0, Math.PI, 0]);
    return [mesh];
  },
  // UV1 runs the other way along u; every vertex is one green.
  painted: () => [
    createMesh(
      engine,
      { ...square(), uvs1: [1, 0, 0, 0, 0, 1, 1, 1], colors: Array(4).fill([0, 0.5, 0]).flat() },
      new UnlitMaterial({ color: '#ffffff' }),
    ),
  ],
  // Four small squares in a row: two materials meshes share one Material, then a core mesh.
  materials: () => {
    const shared = new UnlitMaterial({ color: '#ffffff' });
    return [
      createMesh(engine, square(0.2, -0.7), shared),
      createMesh(engine, square(0.2, -0.2), new UnlitMaterial({ color: '#ffffff' })),
      createMesh(engine, square(0.2, 0.3), shared),
      coreMesh(square(0.18, 0.75)),
    ];
  },
  // Two instances of a one-sided square, the right one mirrored (which still faces the camera).
  instances: () => {
    const mesh = createInstancedMesh(engine, square(0.25), new UnlitMaterial({ color: '#ff0000', side: 'front' }), 2);
    mesh.instances.setMatrixAt(0, matrix(1, -0.5));
    mesh.instances.setMatrixAt(1, matrix(-1, 0.5));
    return [mesh];
  },
};
let made = [],
  view,
  views;
const frame = async () => {
  engine.render({ views });
  await engine.gpu.queue.onSubmittedWorkDone();
};
const settle = async () => {
  await waitForPipelines(frame);
  await frame();
};
/** Runs `work`, draws, and returns the errors, validation ones included. */
const checked = async (work) => {
  engine.gpu.pushErrorScope('validation');
  await work();
  await settle();
  const error = await engine.gpu.popErrorScope();
  if (error) errors.push(error.message);
  return errors.splice(0);
};
window.check = {
  async scene(name) {
    view?.dispose();
    view = undefined;
    for (const mesh of made) mesh.dispose();
    made = scenes[name]();
    await settle();
    return errors.splice(0);
  },
  show: (options) =>
    checked(() => {
      if (!options) {
        view?.dispose();
        view = undefined;
        return;
      }
      // `only`: the index of the one scene mesh the view draws (a materials mesh draws through its nodes).
      const { only, ...rest } = options;
      if (only !== undefined) rest.meshes = made[only].ownedMeshes ?? [made[only]];
      if (view) view.set(rest);
      else view = MeshDebugView.attach(engine, rest);
    }),
  reset: () => checked(() => view.resetMaterialIds()),
  // A deformer's buffer, 256 bytes into storage: the square shrunk to 0.4 across and moved right by 0.5.
  deform: (on) =>
    checked(() => {
      const p = made[0].primitives[0];
      if (!on) {
        p.deformed = p.deformedOffset = undefined;
        return;
      }
      const moved = p.vertices.slice();
      for (let i = 0; i < moved.length; i += 20) moved[i] = moved[i] * 0.4 + 0.5;
      const buffer = engine.gpu.createBuffer({
        size: 256 + moved.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      engine.gpu.queue.writeBuffer(buffer, 256, moved);
      p.deformed = buffer;
      p.deformedOffset = 256;
    }),
  // New geometry on the live materials mesh, scaled; `extra` adds a vertex, so the buffers grow.
  regeometry: (scale, extra) =>
    checked(() => {
      const data = square(0.75 * scale);
      if (extra) {
        data.positions.push(0, 0, 0);
        data.normals.push(0, 0, 1);
        data.uvs.push(0, 0);
      }
      made[0].setGeometry(data);
    }),
  // A new core geometry on the live core mesh.
  swap: (scale) =>
    checked(() => {
      const data = square(0.75 * scale);
      made[0].setGeometry(new Geometry(data.positions, data.normals, data.indices));
    }),
  hide: (visible) => checked(() => (made[0].visible = visible)),
  views: (on) =>
    checked(() => {
      const quarter = (id, at) => ({ id, camera: engine.camera, viewport: [at, at, 0.5, 0.5] });
      views = on ? [quarter('first', 0), quarter('second', 0.5)] : undefined;
    }),
  // Storage buffers made over three frames, each after a pick (which runs the plugins' update between frames).
  async picks() {
    const device = engine.gpu,
      create = device.createBuffer;
    let made = 0;
    device.createBuffer = (descriptor) => {
      if (descriptor.usage & GPUBufferUsage.STORAGE) made++;
      return create.call(device, descriptor);
    };
    for (let i = 0; i < 3; i++) {
      await engine.pick(128, 128);
      await frame();
    }
    device.createBuffer = create;
    return made;
  },
  async restore() {
    await engine.rebootDevice();
    return checked(() => {});
  },
};
window.ready = true;
