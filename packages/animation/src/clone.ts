import { PBRModel, closeImages, type PreparedGeometry } from '@margoengine/gltf-pro/model';
import { MargoError } from '@margoengine/math/errors';

/** The quaternion each node copy passes to setQuaternion (which reads it and keeps nothing). */
const rotation = [0, 0, 0, 1];

/**
 * A second, independent copy of a glTF-pro model, with its own nodes (so its own
 * skeleton) that an `Animation` from this package can play apart from the source (`Animation.attach(clone)`). The
 * clone starts in the source's current local node transforms, visibility and morph weights, with its root unparented
 * at the source root's local transform, and is registered with the engine when the source is (as `loadGLTF` does).
 * It shares the source's parsed asset (document, buffers, accessors), decoded images and packed vertex arrays.
 * gltf-pro shares the GPU textures of shared images, and the GPU vertex and index buffers of shared arrays (and of
 * baked static batches at the same pose), between the copies, freeing each with its last holder in any disposal order;
 * an `Animation` shares the bind-pose vertices, morph deltas and skin influences the same way. Deformed output,
 * weights, bones, uniforms and bind groups are per model. Materials come from the document, so edits made to the
 * source's materials at runtime are not copied. Clone after a progressive load has finished. A copy costs no engine
 * tick, so its world matrices publish with the next one: every frame and pick, and `model.bounds`, run it first.
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
        // Through the transform refs and one quaternion scratch: no arrays per node, the same store writes as the
        // setters. A value the setters refuse (written into the store directly) still gets their own error.
        const x = t.x[a],
          y = t.y[a],
          z = t.z[a],
          sx = t.sx[a],
          sy = t.sy[a],
          sz = t.sz[a];
        if (Number.isFinite(x + y + z)) to.position.set(x, y, z);
        else to.setPosition([x, y, z]);
        if (Number.isFinite(sx + sy + sz) && sx !== 0 && sy !== 0 && sz !== 0) to.scale.set(sx, sy, sz);
        else to.setScale([sx, sy, sz]);
        rotation[0] = t.qx[a];
        rotation[1] = t.qy[a];
        rotation[2] = t.qz[a];
        rotation[3] = t.qw[a];
        to.setQuaternion(rotation);
        to.visible = from.visible;
      };
    copy(model.root, clone.root);
    model.nodes.forEach((node, i) => copy(node, clone!.nodes[i]));
    model.primitives.forEach((p, i) => clone!.primitives[i]?.weights.set(p.weights));
    // Baking would cost a tick of every mesh of the engine per copy; the source's batches fit at this very pose.
    clone.adoptStaticBatches(model);
    if (engine.plugins.get(model.name) === model) engine.use(clone);
    return clone;
  } catch (error) {
    if (clone) clone.dispose();
    else closeImages(images);
    throw error;
  }
}
