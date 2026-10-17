// Built package imports exercise the same loader and rendering boundary as consumers.
import { Engine, Geometry, PbrMaterial } from '../packages/core/dist/extension.js';
import { loadGLTF } from '../packages/gltf-pro/dist/index.js';
import { SectionPlanes } from '../packages/machinery/dist/index.js';
import { Shadows } from '../packages/shadows/dist/index.js';

declare global {
  var margoLow: number | undefined;
}

const parameters = new URLSearchParams(location.search),
  withShadows = parameters.get('shadows') !== 'false';
globalThis.margoLow = parameters.get('samples') === '1' ? 1 : undefined;
const engine = await Engine.create(document.querySelector('canvas')!, {
    backend: 'webgpu',
    camera: { position: [0, 0, 5], target: [0, 0, 0], near: 0.1, far: 20 },
  }),
  device = engine.gpu!,
  errors: string[] = [],
  asset = '/packages/exporters/tests/fixtures/Box.glb',
  model = await loadGLTF(engine, asset),
  section = new SectionPlanes({ planes: [[1, 0, 0, 0]], cap: false }),
  shadows = new Shadows({
    resolution: 1024,
    bounds: { min: [-3, -2, -2], max: [3, 2, 1] },
    lightSize: 0,
    bias: 0.0001,
    normalBias: 0,
  });

engine.stop();
engine.onError = (error) => errors.push(String(error));
device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
// 64 backing pixels per world unit in both axes. The checked-in asset is a ±0.5 cube.
engine.camera.project = (out) => {
  out[0] = 1 / 3;
  out[5] = 1 / 2;
  out[10] = 1 / 19.9;
  out[14] = 20 / 19.9;
  out[15] = 1;
};
engine.lighting.direction.set([-1, 0, 1, 3]);
engine.lighting.radiance[3] = 0.03;
// This receiver is deliberately core geometry; the caster above must remain the real loaded primitive.
engine
  .createMesh()
  .setGeometry(
    new Geometry(
      [-3, -2, -1.5, 3, -2, -1.5, 3, 2, -1.5, -3, 2, -1.5],
      [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      [0, 1, 2, 0, 2, 3],
    ),
  )
  .setMaterial(new PbrMaterial({ color: '#ffffff', roughness: 1 }));
engine.use(section);
if (withShadows) engine.use(shadows);
let removeCaster: (() => void) | undefined,
  sampleCount = 0;
engine.frameGraph.add({
  name: 'section-loaded-asset:observe-samples',
  order: 100,
  execute(context) {
    if (context.backend === 'webgpu') sampleCount = context.descriptor.multisample?.count ?? 1;
  },
});

async function frame(enabled: boolean, caster = true, visible = true) {
  section.enabled = enabled;
  model.root.visible = visible;
  if (withShadows && caster && !removeCaster) removeCaster = shadows.add(model);
  if (!caster && removeCaster) {
    removeCaster();
    removeCaster = undefined;
  }
  device.pushErrorScope('validation');
  try {
    engine.render({ culling: false });
    await device.queue.onSubmittedWorkDone();
  } finally {
    const error = await device.popErrorScope();
    if (error) errors.push(error.message);
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return {
    asset,
    sampleCount,
    primitives: model.primitives.length,
    vertices: model.primitives[0].vertices.length / 20,
    indices: model.primitives[0].indices.length,
    coreGeometry: model.primitives[0].node.geometry !== null,
    shadowSources: model.shadowPrimitives.length,
    shadowDraws: shadows.stats.dynamicDraws,
  };
}

Object.assign(window, {
  sectionLoadedAsset: {
    frame,
    errors,
    dispose() {
      removeCaster?.();
      engine.dispose();
    },
  },
});
