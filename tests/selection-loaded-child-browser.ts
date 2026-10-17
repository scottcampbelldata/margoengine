// Consume built public packages and the checked-in Khronos asset without constructing geometry.
import { Engine } from '../packages/core/dist/extension.js';
import { loadGLTF } from '../packages/gltf-pro/dist/index.js';
import type { Picking, Selection } from '../packages/selection/dist/index.js';
import { selectModel } from '../test-results/selection-loaded-child/readme-example.ts';

declare global {
  var margoLow: number | undefined;
}

const requestedSamples = Number(new URLSearchParams(location.search).get('samples') ?? 4);
globalThis.margoLow = requestedSamples === 1 ? 1 : undefined;
const canvas = document.querySelector('canvas')!,
  engine = await Engine.create(canvas, {
    backend: 'webgpu',
    camera: { position: [3, 1.7, 4], target: [0, 1.1, 0], near: 0.1, far: 40 },
  }),
  device = engine.gpu!,
  errors: string[] = [],
  asset = '/examples/assets/khronos/CommercialRefrigerator/CommercialRefrigerator.glb',
  model = await loadGLTF(engine, asset),
  controller = selectModel(engine, model),
  picking = engine.plugins.get('picking') as Picking,
  selection = engine.plugins.get('selection') as Selection,
  child = model.nodes.find((node) => node.name === 'FridgeDoor')!,
  assembly = model.nodes.find((node) => node.name === 'FridgeCase')!;

engine.stop();
// Keep the exact README controller; use magenta only to identify outline pixels.
selection.options.color = [1, 0, 1];
engine.onError = (error) => errors.push(String(error));
device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
// Open the asset's existing hinged door so the child and the case/interior have separate silhouettes.
child.setRotation([0, 0, 1.1]);
engine.camera.project = (out) => {
  out.fill(0);
  out[0] = out[5] = 1 / 1.7;
  out[10] = 1 / 39.9;
  out[14] = 40 / 39.9;
  out[15] = 1;
};
let sampleCount = 0;
engine.frameGraph.add({
  name: 'selection-loaded-child:observe-samples',
  order: 100,
  execute(context) {
    if (context.backend === 'webgpu') sampleCount = context.descriptor.multisample?.count ?? 1;
  },
});

async function render() {
  device.pushErrorScope('validation');
  try {
    engine.render({ culling: false });
    await device.queue.onSubmittedWorkDone();
  } finally {
    const error = await device.popErrorScope();
    if (error) errors.push(error.message);
  }
  if (errors.length) throw new Error(errors.join('\n'));
}

function pixel(point: readonly number[]) {
  const m = engine.camera.matrix,
    x = m[0] * point[0] + m[4] * point[1] + m[8] * point[2] + m[12],
    y = m[1] * point[0] + m[5] * point[1] + m[9] * point[2] + m[13],
    w = m[3] * point[0] + m[7] * point[1] + m[11] * point[2] + m[15];
  return [((x / w) * 0.5 + 0.5) * canvas.clientWidth, (0.5 - (y / w) * 0.5) * canvas.clientHeight];
}
function descendant(node: (typeof model.nodes)[number], ancestor: (typeof model.nodes)[number]) {
  for (let id = node.id; id !== -1; id = engine.store.parents[id]) if (id === ancestor.id) return true;
  return false;
}
function points(node: (typeof model.nodes)[number]) {
  return model.primitives
    .filter((primitive) => primitive.node === node)
    .map((primitive) => {
      const matrix = node.matrix,
        projected = [];
      for (let i = 0; i < primitive.vertices.length; i += 20) {
        const vertices = primitive.vertices,
          [x, y, z] = vertices.subarray(i, i + 3);
        projected.push(
          pixel([
            matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
            matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
            matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
          ]),
        );
      }
      return { primitive, projected };
    });
}
function projectedBounds(node: (typeof model.nodes)[number]) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const { projected } of points(node))
    for (const at of projected) {
      bounds[0] = Math.min(bounds[0], at[0]);
      bounds[1] = Math.min(bounds[1], at[1]);
      bounds[2] = Math.max(bounds[2], at[0]);
      bounds[3] = Math.max(bounds[3], at[1]);
    }
  return { name: node.name, bounds, inChild: descendant(node, child) };
}
async function frame(mode: 'baseline' | 'child' | 'root' | 'all-nodes' | 'miss') {
  if (mode === 'baseline') selection.set([]);
  await render();
  // Fixed genuine surface pixels for this asset/camera: the door frame and the
  // exposed case side. A miss starts with the preceding selection still active.
  const at = mode === 'child' ? [115, 226] : mode === 'root' ? [207, 144] : [2, 2],
    controllerMesh = mode === 'baseline' || mode === 'all-nodes' ? null : await controller.pick(at[0], at[1]),
    hit = mode === 'baseline' || mode === 'all-nodes' ? null : await picking.pick(at[0], at[1]);
  if (mode === 'all-nodes') selection.set(model.primitives.map((primitive) => primitive.node));
  await render();
  return {
    asset,
    requestedSamples,
    sampleCount,
    mode,
    at,
    controllerName: controllerMesh?.name ?? null,
    controllerMatchesHit: controllerMesh === (hit?.mesh ?? null),
    hitName: hit?.mesh.name ?? null,
    hitIsChild: hit?.mesh === child,
    hitIsAssemblyRoot: hit?.mesh === assembly,
    hitIsLoaderWrapper: hit?.mesh === model.root,
    hitOwnsModel: hit?.model === model,
    assemblyParentsChild: descendant(child, assembly),
    assemblyIsSceneRoot: engine.store.parents[assembly.id] === model.root.id,
    rootHasPrimitive: model.primitives.some((primitive) => primitive.node === assembly),
    selectedName: hit?.mesh.name ?? null,
    nodes: model.nodes.length,
    primitives: model.primitives.length,
    coreGeometries: model.primitives.filter((primitive) => primitive.node.geometry !== null).length,
    regions: model.nodes.map(projectedBounds),
  };
}
Object.assign(window, {
  selectionLoadedChild: {
    frame,
    errors,
    dispose() {
      controller.dispose();
      engine.dispose();
    },
  },
});
