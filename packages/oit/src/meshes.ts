import type { EngineKernel, Mesh, Scene } from '@margoengine/core';
import { Material, createMesh } from '@margoengine/materials';
import type { TransparentPass } from './pass.js';

let copies = 0;

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
    material = new Material({
      color: [data[0], data[1], data[2]],
      roughness: data[4],
      metalness: data[5],
      doubleSided: !!data[6],
      opacity,
      transparent: true,
    }),
    // The copy, and the draw queue materials makes for it, join the scene of the mesh they follow: core makes meshes
    // and plugins in the active scene, and a plugin's setup runs with its scene active (a parent must share the scene).
    scene = (mesh as Mesh & { scene?: Scene }).scene ?? engine.scene,
    name = `oit-mesh-copy:${++copies}`;
  let copy!: ReturnType<typeof createMesh<Material>>;
  scene.use({
    name,
    setup() {
      copy = createMesh(engine, { positions, normals, indices: geometry.indices }, material);
    },
  });
  scene.removePlugin(name);
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
