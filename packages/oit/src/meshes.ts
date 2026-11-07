import type { EngineKernel, Mesh } from '@margoengine/core';
import { Material, createMesh } from '@margoengine/materials';
import type { TransparentPass } from './pass.js';

/** `addMesh` settings. */
export interface OITMeshOptions {
  /** Coverage from 0 (invisible) to 1. Default 0.5. */
  opacity?: number;
}

/**
 * Draws a core mesh see-through in an order-independent pass (`OIT`, `ExactOIT`). Core meshes are opaque, so its colour, roughness, metalness, sides
 * and geometry are copied at this call to a transparent materials mesh that follows its transforms and `visible`. The
 * core mesh gives up its geometry (no opaque draw, no shadow, no pick) until the returned function restores it.
 * @throws TypeError for a mesh without geometry.
 * @throws RangeError for an `opacity` outside 0 to 1.
 */
export function addMesh(
  oit: TransparentPass,
  engine: EngineKernel,
  mesh: Mesh,
  { opacity = 0.5 }: OITMeshOptions = {},
): () => void {
  const geometry = mesh?.geometry;
  if (!geometry) throw new TypeError('addMesh needs a core mesh with geometry; call setGeometry first');
  if (!(opacity >= 0 && opacity <= 1)) throw new RangeError('Invalid addMesh opacity; use 0 to 1');
  const count = geometry.vertices.length / 6,
    positions = new Float32Array(count * 3),
    normals = new Float32Array(count * 3);
  for (let i = 0; i < count; i++)
    for (let k = 0; k < 3; k++) {
      positions[i * 3 + k] = geometry.vertices[i * 6 + k];
      normals[i * 3 + k] = geometry.vertices[i * 6 + 3 + k];
    }
  const data = mesh.material.data,
    copy = createMesh(
      engine,
      { positions, normals, indices: geometry.indices },
      new Material({
        color: [data[0], data[1], data[2]],
        roughness: data[4],
        metalness: data[5],
        doubleSided: !!data[6],
        opacity,
        transparent: true,
      }),
    );
  copy.root.setParent(mesh as never);
  const remove = oit.add(copy);
  // Not `visible = false`: hiding a mesh hides what is parented to it.
  mesh.setGeometry(null);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    remove();
    copy.destroy();
    mesh.setGeometry(geometry);
  };
}
