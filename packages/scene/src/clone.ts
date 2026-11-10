import type { Mesh } from '@margoengine/core';
import { meshRuntime } from '@margoengine/core/extension';
import { typeError } from '../../shared/errors.js';
import { parent, traverse, userData } from './index.js';

/** Options for {@link cloneSubtree}. */
export interface CloneOptions {
  /** Include all descendants. Default true. */
  recursive?: boolean;
  /** Parent for the copied root in the source scene. Default null (scene root). Local TRS is copied. */
  parent?: Mesh | null;
}

/**
 * Copy a mesh hierarchy in its owning scene. Geometry and materials are shared and retained by core;
 * names, visibility, receiveShadow, local TRS and structured-cloneable userData are copied.
 * Metadata is independent (cycles and cross-node aliases retained). Listeners and package plugins are not copied.
 * Invalid metadata rejects before allocation; an allocation failure disposes every new mesh.
 */
export function cloneSubtree(source: Mesh, { recursive = true, parent: targetParent = null }: CloneOptions = {}): Mesh {
  source.check(); targetParent?.check();
  if (typeof recursive !== 'boolean') throw typeError('cloneSubtree: recursive must be boolean', 'arguments');
  const runtime = meshRuntime(source);
  if (targetParent && (meshRuntime(targetParent).engine !== runtime.engine || meshRuntime(targetParent).scene !== runtime.scene))
    throw typeError('cloneSubtree: parent must belong to the source scene', 'hierarchy');
  const sources: Mesh[] = [];
  if (recursive) traverse(source, (mesh) => sources.push(mesh));
  else sources.push(source);
  // One clone operation retains metadata aliases within the copy but never aliases ordinary source data.
  let metadata: Record<string, unknown>[];
  try { metadata = structuredClone(sources.map((mesh) => userData(mesh))); }
  catch (cause) { throw Object.assign(typeError('cloneSubtree: use structured-cloneable userData', 'arguments'), { cause }); }
  for (const mesh of sources) mesh.check();
  const copies = new Map<Mesh, Mesh>();
  try {
    for (const [i, mesh] of sources.entries()) {
      const above = mesh === source ? targetParent : copies.get(parent(mesh)!)!;
      const copy = runtime.scene.createMesh(above ? meshRuntime(above) : null);
      copies.set(mesh, copy);
      copy.name = mesh.name;
      copy.visible = mesh.visible;
      copy.receiveShadow = mesh.receiveShadow;
      copy.setGeometry(mesh.geometry).setMaterial(mesh.material);
      // Exact stored values, including Euler hints, without a second quaternion normalization.
      const from = meshRuntime(mesh), to = meshRuntime(copy);
      for (const key of ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw', 'sx', 'sy', 'sz'] as const)
        to.engine.store.transforms[key][to.id] = from.engine.store.transforms[key][from.id];
      to.engine.store.rotations.set(from.engine.store.rotations.subarray(from.id * 3, from.id * 3 + 3), to.id * 3);
      userData(copy, metadata[i]);
    }
    return copies.get(source)!;
  } catch (error) {
    const errors: unknown[] = [error];
    for (const mesh of [...copies.values()].reverse()) {
      try { mesh.dispose(); } catch (cleanup) { errors.push(cleanup); }
    }
    if (errors.length > 1) throw new AggregateError(errors, 'cloneSubtree: allocation and cleanup failed; dispose the engine');
    throw error;
  }
}
