// Built package imports exercise the same loaders and draw boundary as consumers. Every mesh comes from a loaded file.
import { Engine } from '../packages/core/dist/extension.js';
import {
  parseCAD,
  parseCADAsync,
  deduplicateParts,
  PartInstancer,
  SectionPlanes,
} from '../packages/machinery/dist/index.js';
import { loadGLTF } from '../packages/gltf-pro/dist/index.js';
import { Picking } from '../packages/selection/dist/index.js';
import { Shadows } from '../packages/shadows/dist/index.js';

declare global {
  var margoLow: number | undefined;
  var occtimportjs: (options: { locateFile: (file: string) => string }) => Promise<{
    ReadStepFile(data: Uint8Array, options: unknown): { meshes: { index: { array: number[] } }[] };
  }>;
}

const parameters = new URLSearchParams(location.search),
  scenario = parameters.get('scenario') ?? 'cad',
  samples = parameters.get('samples') === '1' ? 1 : 4;
globalThis.margoLow = samples === 1 ? 1 : undefined;

// Counts every indexed draw the frame encodes (core batches, packs, shadows, caps' stencil passes).
const counters = { indexed: 0, indirect: 0, single: 0 },
  encoder = GPURenderPassEncoder.prototype,
  drawIndexed = encoder.drawIndexed,
  drawIndexedIndirect = encoder.drawIndexedIndirect;
encoder.drawIndexed = function (count: number, instances = 1, ...rest: number[]) {
  counters.indexed++;
  if (instances === 1 && count === 36) counters.single++;
  return drawIndexed.call(this, count, instances, ...rest);
};
encoder.drawIndexedIndirect = function (buffer: GPUBuffer, offset: number) {
  counters.indirect++;
  return drawIndexedIndirect.call(this, buffer, offset);
};

const engine = await Engine.create(document.querySelector('canvas')!, {
    backend: 'webgpu',
    camera: { position: [0, 0, 5], target: [0, 0, 0], near: 0.1, far: 20 },
  }),
  device = engine.gpu!,
  errors: string[] = [];
engine.stop();
engine.onError = (error) => errors.push(String(error));
device.addEventListener('uncapturederror', (event) => errors.push((event as GPUUncapturedErrorEvent).error.message));
// 64 backing pixels per world unit in both axes: screen x = 192 + 64 * worldX, y = 128 - 64 * worldY.
engine.camera.project = (out: Float32Array) => {
  out[0] = 1 / 3;
  out[5] = 1 / 2;
  out[10] = 1 / 19.9;
  out[14] = 20 / 19.9;
  out[15] = 1;
};
engine.lighting.direction.set([-1, 0, 1, 3]);
engine.lighting.radiance[3] = 0.03;
let sampleCount = 0;
engine.frameGraph.add({
  name: 'machinery-pack:observe-samples',
  order: 100,
  execute(context) {
    if (context.backend === 'webgpu') sampleCount = context.descriptor.multisample?.count ?? 1;
  },
});

async function frame() {
  counters.indexed = counters.indirect = counters.single = 0;
  device.pushErrorScope('validation');
  try {
    engine.render({ culling: false });
    await device.queue.onSubmittedWorkDone();
  } finally {
    const error = await device.popErrorScope();
    if (error) errors.push(error.message);
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return { ...counters, draws: counters.indexed + counters.indirect, drawCalls: engine.stats.drawCalls, sampleCount };
}

async function cad() {
  const text = await (await fetch('/test-results/machinery-pack/assembly.obj')).text(),
    model = parseCAD(engine, text, 'obj'),
    byName = (name: string) => model.meshes.find((mesh) => mesh.name === name)!;
  let instancer: PartInstancer | undefined,
    picking: Picking | undefined,
    section: SectionPlanes | undefined,
    shadows: Shadows | undefined,
    removeCaster: (() => void) | undefined,
    partCasters: (() => void)[] = [];
  return {
    parts: model.meshes.length,
    geometries: new Set(model.meshes.map((mesh) => mesh.geometry)).size,
    frame,
    attach() {
      instancer = PartInstancer.attach(engine);
    },
    setPack(on: boolean) {
      instancer!.pack = on;
    },
    stats: () => ({ ...instancer!.stats }),
    move(name: string, dx: number) {
      byName(name).position.x += dx;
    },
    hide(name: string) {
      byName(name).visible = false;
    },
    async enginePick(x: number, y: number) {
      return (await engine.pick(x, y))?.name ?? null;
    },
    attachPicking() {
      picking = Picking.attach(engine);
    },
    async picking(x: number, y: number) {
      return (await picking!.pick(x, y))?.mesh.name ?? null;
    },
    removePicking() {
      engine.removePlugin(picking!.name);
    },
    attachSection() {
      section = SectionPlanes.attach(engine, { planes: [[0, 0, -1, 0]], cap: true, hatch: 0 });
      shadows = Shadows.attach(engine, {
        resolution: 1024,
        bounds: { min: [-3, -2, -2], max: [3, 2, 1] },
        lightSize: 0,
        bias: 0.0001,
        normalBias: 0,
      });
    },
    /** One section frame: `caster` adds the packs as the only shadow caster; `partCasters` adds every part too. */
    async section(enabled: boolean, caster: boolean, withParts = false) {
      section!.enabled = enabled;
      if (caster && !removeCaster) removeCaster = shadows!.add(instancer!);
      if (!caster && removeCaster) {
        removeCaster();
        removeCaster = undefined;
      }
      if (withParts && !partCasters.length)
        partCasters = model.meshes.filter((mesh) => mesh.name !== 'wall').map((mesh) => shadows!.add(mesh));
      if (!withParts && partCasters.length) {
        for (const remove of partCasters) remove();
        partCasters = [];
      }
      return { ...(await frame()), stats: { ...instancer!.stats } };
    },
    dispose() {
      engine.dispose();
    },
  };
}

async function gltf() {
  engine.camera.project = (out: Float32Array) => {
    out[0] = 1 / 6;
    out[5] = 1 / 4;
    out[10] = 1 / 19.9;
    out[14] = 20 / 19.9;
    out[15] = 1;
  };
  const model = await loadGLTF(engine, '/test-results/machinery-pack/dedup.gltf'),
    primitive = (name: string) => model.primitives.find((p) => p.node.name === name)!,
    names = ['static-a', 'static-b', 'skinned', 'morphed'],
    pairs = () =>
      Object.fromEntries(
        names.map((name) => {
          const p = primitive(name);
          return [name, [p.buffers!.vertex, p.buffers!.index]];
        }),
      ) as Record<string, GPUBuffer[]>,
    ids = new Map<GPUBuffer, number>(),
    id = (buffer: GPUBuffer) => (ids.has(buffer) ? ids.get(buffer)! : (ids.set(buffer, ids.size), ids.size - 1)),
    describe = (pair: Record<string, GPUBuffer[]>) =>
      Object.fromEntries(Object.entries(pair).map(([name, [vertex, index]]) => [name, [id(vertex), id(index)]]));
  return {
    primitives: model.primitives.length,
    names: model.primitives.map((p) => p.node.name),
    vertices: names.map((name) => primitive(name).vertices.length / 20),
    distinctArrays: new Set(names.map((name) => primitive(name).vertices)).size,
    frame,
    before: () => describe(pairs()),
    dedup: () => deduplicateParts(model.nodes),
    after: () => describe(pairs()),
    dispose() {
      engine.dispose();
    },
  };
}

async function step() {
  const bytes = new Uint8Array(
      await (await fetch('/node_modules/occt-import-js/test/testfiles/rounded-cube/rounded-cube.step')).arrayBuffer(),
    ),
    triangles = (model: { meshes: readonly { geometry: { indices: Uint32Array } | null }[] }) =>
      model.meshes.reduce((sum, mesh) => sum + mesh.geometry!.indices.length / 3, 0),
    load = async (options: { linearDeflection?: number }) => {
      const model = await parseCADAsync(engine, bytes.slice().buffer, 'step', options),
        count = triangles(model);
      model.dispose();
      return count;
    };
  // Today's call, made directly: OpenCascade with the parameters parseCADAsync passed before linearDeflection existed.
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/packages/machinery/dist/workers/occt-import-js.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('OpenCascade script failed to load'));
    document.head.append(script);
  });
  const occt = await occtimportjs({ locateFile: () => '/packages/machinery/dist/workers/occt-import-js.wasm' }),
    direct = occt
      .ReadStepFile(bytes.slice(), { linearUnit: 'meter' })
      .meshes.reduce((sum, mesh) => sum + mesh.index.array.length / 3, 0);
  return { direct, load };
}

/** The 50,000-box OBJ through the worker import, then packed; times are wall-clock milliseconds on this page. */
async function large() {
  engine.camera.project = undefined;
  Object.assign(engine.camera, { position: [150, 220, 330], target: [150, 0, 120], near: 1, far: 2000 });
  const started = performance.now(),
    buffer = await (await fetch('/test-results/cad-pack-50000/parts-50000.obj')).arrayBuffer(),
    bytes = buffer.byteLength,
    fetched = performance.now(),
    model = await parseCADAsync(engine, buffer, 'obj'),
    loaded = performance.now();
  const times = async (count: number) => {
    const samples: number[] = [];
    let last = await frame();
    for (let i = 0; i < count; i++) {
      const start = performance.now();
      last = await frame();
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    return { median: samples[samples.length >> 1], min: samples[0], max: samples.at(-1)!, last };
  };
  return {
    bytes,
    parts: model.meshes.length,
    unique: new Set(model.meshes.map((mesh) => mesh.geometry)).size,
    fetchMs: fetched - started,
    parseMs: loaded - fetched,
    async run() {
      const unpacked = await times(5),
        attachStart = performance.now(),
        instancer = PartInstancer.attach(engine),
        attachMs = performance.now() - attachStart,
        buildStart = performance.now(),
        build = await frame(),
        buildMs = performance.now() - buildStart,
        packed = await times(9);
      return { unpacked, attachMs, buildMs, build, packed, stats: { ...instancer.stats } };
    },
    dispose() {
      engine.dispose();
    },
  };
}

Object.assign(window, {
  machineryPack:
    scenario === 'gltf'
      ? await gltf()
      : scenario === 'step'
        ? await step()
        : scenario === 'large'
          ? await large()
          : await cad(),
  machineryPackErrors: errors,
});
