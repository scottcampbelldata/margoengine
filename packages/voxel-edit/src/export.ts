// Export helper: a plain scene `{nodes}` that exportGLB, exportUSDZ and exportOBJ accept.
import { meshGrid, partitionMesh, type GridMesh } from './mesh.js';
import type { VoxelGrid } from './grid.js';

/** Palette material written onto one primitive. */
export interface ExportMaterial {
  /** Palette index this material belongs to. */
  index: number;
  /** Linear RGB base colour. */
  color: [number, number, number];
  /** Optional metalness, 0 to 1. */
  metalness?: number;
  /** Optional roughness, 0 to 1. */
  roughness?: number;
}

/** One material's triangles, the shape the exporters' `ExportPrimitive` reads. */
export interface VoxelExportPrimitive {
  /** Triangles in cells: xyz positions, unit normals and indices. */
  geometry: {
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint32Array;
    /** Per-vertex ambient occlusion as rgb, present when the mesh was built with ambient occlusion. */
    colors?: Float32Array;
  };
  /** Named `palette-<index>`; linear RGBA colour, roughness and metalness from the matching {@link ExportMaterial}. */
  material: {
    name: string;
    color: [number, number, number, number];
    roughness: number;
    metalness: number;
    doubleSided: boolean;
  };
}

/**
 * A plain data scene. `nodes` is what `exportGLB`, `exportUSDZ` and `exportOBJ` require.
 * `mesh` is the mesh the primitives were split from, hard cubic unless one was passed.
 */
export interface VoxelExportSource {
  /** One node holding every primitive. */
  nodes: { name?: string; primitives: VoxelExportPrimitive[] }[];
  /** The quad mesh the primitives were split from. */
  mesh: GridMesh;
  /** The scene name, `options.name` or `'voxels'`. */
  name?: string;
}

/**
 * Mesh a grid and split it by palette so `exportGLB(gridToExportSource(...))` writes one primitive per material.
 * Vertex colors, when ambient occlusion is on, are the corner AO so a viewer darkens those corners.
 */
export function gridToExportSource(
  grid: VoxelGrid,
  materials: readonly ExportMaterial[],
  options: {
    name?: string;
    ambientOcclusion?: boolean;
    smoothNormals?: boolean;
    /** A mesh already built from the grid, such as `smoothGrid`'s, used in place of the hard cubic one. */
    mesh?: GridMesh;
  } = {},
): VoxelExportSource {
  const name = options.name ?? 'voxels';
  const mesh =
    options.mesh ??
    meshGrid(grid, {
      ambientOcclusion: options.ambientOcclusion,
      smoothNormals: options.smoothNormals,
    }).mesh;
  const byIndex = new Map(materials.map((material) => [material.index, material]));
  const primitives = partitionMesh(mesh).map((part) => {
    const material = byIndex.get(part.paletteIndex);
    const color = material?.color ?? [1, 1, 1];
    let colors: Float32Array | undefined;
    if (part.ao.length) {
      colors = new Float32Array(part.ao.length * 3);
      for (let i = 0; i < part.ao.length; i++) colors.set([part.ao[i], part.ao[i], part.ao[i]], i * 3);
    }
    return {
      geometry: {
        positions: part.positions,
        normals: part.normals,
        indices: part.indices,
        ...(colors ? { colors } : {}),
      },
      material: {
        name: `palette-${part.paletteIndex}`,
        color: [color[0], color[1], color[2], 1] as [number, number, number, number],
        roughness: material?.roughness ?? 1,
        metalness: material?.metalness ?? 0,
        doubleSided: false,
      },
    };
  });
  return { nodes: [{ name, primitives }], mesh, name };
}
