// Headless PBRModel comparison for the parser-worker equality tests (gltf-pro, fbx, usdz).
import { PBRModel } from '../../packages/gltf-pro/dist/index.js';
import { Engine, TransformStore } from '../../packages/core/dist/extension.js';

export const headless = async (gpu = null) =>
  new Engine({ width: 64, height: 64, clientWidth: 64, clientHeight: 64 }, await TransformStore.create(4096), {
    backend: gpu ? 'webgpu' : 'webgl2',
    gpu,
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });

/** Everything a PBRModel exposes or wrote into its engine, for byte-for-byte comparison. */
export function snapshot(model) {
  const store = model.root.engine.store,
    doc = model.asset.doc;
  return {
    doc,
    buffers: model.asset.buffers,
    images: model['images'],
    names: model.nodes.map((node) => node.name),
    accessors: (doc.accessors ?? []).map((_, i) => {
      try {
        return model.asset.accessor(i);
      } catch (error) {
        return error.message;
      }
    }),
    primitives: model.primitives.map(({ node, deformed, buffers, ...p }) => p),
    lights: model.lights.map(({ node, ...light }) => light),
    cameras: model.cameras.map(({ node, ...camera }) => camera),
    store: {
      parents: store.parents,
      rotations: store.rotations,
      hidden: store.hidden,
      ...Object.fromEntries(Object.entries(store.transforms).filter(([, v]) => ArrayBuffer.isView(v))),
    },
  };
}

/**
 * Node has no GPU and no image decoder: PBRModel setup is a no-op and createImageBitmap returns the encoded bytes.
 * On an engine without a device the real setup refuses before any pass is registered, so registerPasses is skipped
 * there too; otherwise GPU-only helpers it acquires (the native glass capture) refuse the device-less engine.
 */
export async function headlessModels(run) {
  const setup = PBRModel.prototype.setup,
    registerPasses = PBRModel.prototype.registerPasses,
    bitmap = globalThis.createImageBitmap,
    canvas = globalThis.OffscreenCanvas;
  PBRModel.prototype.setup = () => {};
  PBRModel.prototype.registerPasses = function (...args) {
    if (this.engine.gpu) return registerPasses.apply(this, args);
  };
  globalThis.createImageBitmap = async (source, options) =>
    source instanceof Blob
      ? {
          width: 4,
          height: 4,
          bytes: new Uint8Array(await source.arrayBuffer()),
          type: source.type,
          options: options ?? null,
        }
      : { width: source.width, height: source.height, pixels: source.pixels };
  try {
    return await run();
  } finally {
    PBRModel.prototype.setup = setup;
    PBRModel.prototype.registerPasses = registerPasses;
    globalThis.createImageBitmap = bitmap;
    globalThis.OffscreenCanvas = canvas;
  }
}
