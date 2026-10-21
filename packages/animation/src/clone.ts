import { PBRModel, type GLTFImage, type PreparedGeometry } from '@margoengine/gltf-pro';
import { MargoError } from '@margoengine/math/errors';

/** Decoded bitmaps are closed when their model is disposed, so each clone owns a copy; other image kinds are shared. */
async function own(image: GLTFImage): Promise<GLTFImage> {
  if (typeof globalThis.ImageBitmap !== 'function' || !(image instanceof globalThis.ImageBitmap)) return image;
  if (typeof globalThis.createImageBitmap !== 'function')
    throw new MargoError('unsupported', 'cloneModel needs createImageBitmap to copy textures; clone in a browser');
  return createImageBitmap(image);
}

/**
 * A second, independent copy of a glTF-pro model, with its own nodes (so its own
 * skeleton) that an `Animation` from this package can play apart from the source (`Animation.attach(clone)`). The
 * clone starts in the source's current local node transforms, visibility and morph weights, with its root unparented
 * at the source root's local transform, and is registered with the engine when the source is (as `loadGLTF` does).
 * It shares the source's parsed asset (document, buffers, accessors) and compressed textures, and its packed vertex
 * arrays where gltf-pro cached them (worker and progressive loads, prepared static scenes); otherwise the clone packs
 * its own from the shared accessors. Decoded bitmaps are copied (`createImageBitmap`) because disposing a model closes
 * its own. GPU buffers and textures are created per model by gltf-pro. Materials come from the document, so edits made
 * to the source's materials at runtime are not copied. Clone after a progressive load has finished.
 */
export async function cloneModel(model: PBRModel): Promise<PBRModel> {
  if (!(model instanceof PBRModel)) throw new TypeError('cloneModel needs a glTF-pro PBRModel; pass a loaded model');
  if (model.disposed) throw new MargoError('disposed', 'cloneModel source is disposed; clone a live model');
  const images = (model as unknown as { readonly images?: readonly GLTFImage[] }).images;
  if (!Array.isArray(images))
    throw new MargoError('unsupported', 'cloneModel cannot read this gltf-pro model; use matching package versions');
  const copies = await Promise.all(images.map(own)),
    release = () => {
      for (const image of copies) if (image && !images.includes(image) && 'close' in image) image.close();
    };
  if (model.disposed) {
    release();
    throw new MargoError('disposed', 'cloneModel source was disposed while copying textures; clone a live model');
  }
  const doc = model.asset.doc,
    engine = model.root.engine;
  // A prepared static scene has no buffers to decode: hand the clone the source's packed arrays.
  let prepared: PreparedGeometry[][] | undefined;
  if (!doc.buffers?.length) {
    const packed = new Map<object, PreparedGeometry>();
    for (const p of [...model.primitives, ...model.pointsAndLines])
      packed.set(p.definition, p.topology ? { vertices: p.vertices, indices: p.indices, topology: p.topology } : p);
    prepared = (doc.meshes ?? []).map((mesh) => (mesh.primitives ?? []).map((p) => packed.get(p)!));
  }
  let clone: PBRModel | undefined;
  try {
    clone = new PBRModel(engine, model.asset, copies, prepared);
    const t = engine.store.transforms,
      copy = (from: (typeof model.nodes)[number], to: (typeof model.nodes)[number]) => {
        const a = from.id;
        to.setPosition([t.x[a], t.y[a], t.z[a]])
          .setScale([t.sx[a], t.sy[a], t.sz[a]])
          .setQuaternion([t.qx[a], t.qy[a], t.qz[a], t.qw[a]]);
        to.visible = from.visible;
      };
    copy(model.root, clone.root);
    model.nodes.forEach((node, i) => copy(node, clone!.nodes[i]));
    model.primitives.forEach((p, i) => clone!.primitives[i]?.weights.set(p.weights));
    if (engine.plugins.get(model.name) === model) engine.use(clone);
    return clone;
  } catch (error) {
    if (clone) clone.dispose();
    else release();
    throw error;
  }
}
