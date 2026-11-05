import { PBRModel, closeImages, type PreparedGeometry } from '@margoengine/gltf-pro';
import { MargoError } from '@margoengine/math/errors';

/**
 * A second, independent copy of a glTF-pro model, with its own nodes (so its own
 * skeleton) that an `Animation` from this package can play apart from the source (`Animation.attach(clone)`). The
 * clone starts in the source's current local node transforms, visibility and morph weights, with its root unparented
 * at the source root's local transform, and is registered with the engine when the source is (as `loadGLTF` does).
 * It shares the source's parsed asset (document, buffers, accessors) and decoded images, and its packed vertex
 * arrays where gltf-pro cached them (worker and progressive loads, prepared static scenes); otherwise the clone packs
 * its own from the shared accessors. gltf-pro shares the GPU textures of shared images, and the GPU vertex and index
 * buffers of shared arrays (and of baked static batches at the same pose), between the copies, freeing each with its
 * last holder in any disposal order; uniforms and bind groups are per model. Materials come from the document, so
 * edits made to the source's materials at runtime are not copied. Clone after a progressive load has finished.
 */
export async function cloneModel(model: PBRModel): Promise<PBRModel> {
  if (!(model instanceof PBRModel)) throw new TypeError('cloneModel needs a glTF-pro PBRModel; pass a loaded model');
  if (model.disposed) throw new MargoError('disposed', 'cloneModel source is disposed; clone a live model');
  const images = model.shareImages(),
    doc = model.asset.doc,
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
    clone = new PBRModel(engine, model.asset, images, prepared);
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
    else closeImages(images);
    throw error;
  }
}
