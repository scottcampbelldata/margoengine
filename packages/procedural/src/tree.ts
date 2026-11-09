import { Geometry, PbrMaterial, type EngineKernel, type Mesh } from '@margoengine/core';
import { generateTreeMesh, type MeshDetailOptions } from './foliage.js';
import { fault } from '../../shared/errors.js';

/** Single-call tree placement; geometry detail defaults to 2. */
export interface TreeOptions extends MeshDetailOptions {
  /** Root XYZ in metres, finite float32 coordinates. Default [0,0,0]. */
  position?: readonly [number, number, number];
  /** Borrowed material; default brown, roughness 0.9. */
  trunkMaterial?: PbrMaterial;
  /** Borrowed material; default green, roughness 0.85, double sided. */
  canopyMaterial?: PbrMaterial;
}
/** One placed tree with both parts. Dispose this object to remove all three meshes. */
export interface PlacedTree {
  readonly root: Mesh;
  readonly trunk: Mesh;
  readonly canopy: Mesh;
  dispose(): void;
  [Symbol.dispose](): void;
}
/** Creates a rooted trunk and canopy together. Moving the root moves the complete tree. */
export function createTree(engine: EngineKernel, kind: 'conifer' | 'broadleaf', options: TreeOptions = {}): PlacedTree {
  const position = options.position ?? [0, 0, 0];
  if (position.length !== 3 || !Array.from(position).every((v) => Number.isFinite(Math.fround(v))))
    throw fault('failed', 'Tree position needs three finite float32 coordinates', 'procedural');
  for (const material of [options.trunkMaterial, options.canopyMaterial])
    if (material !== undefined && !(material instanceof PbrMaterial))
      throw fault('failed', 'Tree materials must be PbrMaterial instances', 'procedural');
  const data = generateTreeMesh(kind, options),
    wood = new Geometry(data.trunk.positions, data.trunk.normals, data.trunk.indices),
    leaves = new Geometry(data.canopy.positions, data.canopy.normals, data.canopy.indices),
    created: Mesh[] = [];
  try {
    const root = engine.createMesh();
    created.push(root);
    root.setPosition(position);
    const trunk = engine.createMesh(root);
    created.push(trunk);
    trunk.setGeometry(wood).setMaterial(options.trunkMaterial ?? new PbrMaterial({ color: '#68462e', roughness: 0.9 }));
    const canopy = engine.createMesh(root);
    created.push(canopy);
    canopy
      .setGeometry(leaves)
      .setMaterial(options.canopyMaterial ?? new PbrMaterial({ color: '#4c7434', roughness: 0.85 }));
    return {
      root,
      trunk,
      canopy,
      dispose() {
        for (let i = created.length - 1; i >= 0; i--) created[i].dispose();
      },
      [Symbol.dispose]() {
        this.dispose();
      },
    };
  } catch (error) {
    for (let i = created.length - 1; i >= 0; i--) created[i].dispose();
    throw error;
  }
}
