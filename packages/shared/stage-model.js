// A model a stage feature entry imported (addGLTF in @margoengine/stage, addCAD in @margoengine/cad), wrapped as the
// stage's LoadedModel: its world bounds, its raw GPU buffers, and the load options and placing both entries share.
import { meshTriangles } from './mesh-source.js';
import { fault, typeError } from './errors.js';

/** World-space bounds (min xyz, max xyz) of `meshes` into `output`; `visibleOnly` skips hidden meshes. */
export function worldBounds(instance, meshes, output, visibleOnly = false) {
  const engine = instance;
  if (engine.disposed) throw fault('disposed', 'Engine disposed');
  engine.store.tick(false);
  output.fill(Infinity, 0, 3);
  output.fill(-Infinity, 3);
  // PBR positions are the CPU bind pose; reading bounds never encodes deformation.
  const include = (vertices, stride, m) => {
    for (let offset = 0; offset < vertices.length; offset += stride) {
      const x = vertices[offset],
        y = vertices[offset + 1],
        z = vertices[offset + 2];
      for (let axis = 0; axis < 3; axis++) {
        const value = m[axis] * x + m[4 + axis] * y + m[8 + axis] * z + m[12 + axis];
        output[axis] = Math.min(output[axis], value);
        output[axis + 3] = Math.max(output[axis + 3], value);
      }
    }
  };
  for (const mesh of meshes) {
    mesh.check();
    if (mesh.engine !== engine) throw typeError('Foreign mesh', 'hierarchy');
    if (visibleOnly && !engine.store.visible[mesh.id]) continue;
    const triangles = meshTriangles(mesh);
    if (triangles?.kind === 'core') include(triangles.geometry.vertices, 6, mesh.matrix);
    else if (triangles?.kind === 'pbr')
      for (const primitive of triangles.source.primitives) include(primitive.vertices, 20, primitive.node.matrix);
  }
  if (!Number.isFinite(output[0])) throw fault('state', 'No geometry', 'geometry');
  return output;
}

/** Wraps an imported model (root, meshes, dispose) as a LoadedModel. */
export function loadedModel(engine, model) {
  const bounds = new Float32Array(6);
  return {
    root: model.root,
    meshes: model.meshes,
    position: model.root.position,
    rotation: model.root.rotation,
    scale: model.root.scale,
    get visible() {
      return model.root.visible;
    },
    set visible(value) {
      model.root.visible = value;
    },
    get bounds() {
      model.root.check();
      return worldBounds(engine, model.meshes, bounds);
    },
    get raw() {
      model.root.check();
      if (engine.backend !== 'webgpu') return null;
      const buffers = new Set(),
        draws = [],
        seen = new Set();
      for (const mesh of model.meshes) {
        mesh.check();
        if (mesh.engine !== engine) throw typeError('Foreign mesh', 'hierarchy');
        if (seen.has(mesh)) continue;
        seen.add(mesh);
        const triangles = meshTriangles(mesh);
        if (triangles?.kind === 'core') buffers.add(engine.geometryBuffers(triangles.geometry));
        else if (triangles?.kind === 'pbr') for (const draw of triangles.source.draws) draws.push(draw);
      }
      return [...buffers, ...draws];
    },
    destroy() {
      model.dispose();
    },
  };
}

/** Validates the shared load options of the model loaders (`addGLTF`, `addCAD`). */
export function loadTarget(url, fit) {
  if (typeof fit !== 'boolean')
    throw typeError(
      'Invalid fit: expected a boolean; use true to fit the camera or false to keep its view',
      'arguments',
    );
  return new URL(url, globalThis.location?.href);
}

/** Fits the camera to an imported model and wraps it as a LoadedModel; a failure retires the model. */
export function placeModel(stage, model, fit, abort) {
  try {
    abort.throwIfAborted();
    if (fit) stage.fit(model.meshes);
    return loadedModel(stage.engine, model);
  } catch (error) {
    model.dispose();
    throw error;
  }
}
