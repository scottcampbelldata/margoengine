import type { MeshGeometry } from '@margoengine/materials';
import type { BlockType } from './blocks.js';
import { cellBoxes } from './model-data.js';
import { faceCorner, faceRectangles } from './model-surface.js';
import type { VoxelWorld } from './world.js';
/** One texture/type group of an extracted chunk surface, ready for materials.createMesh. */
export interface BlockModelSurface extends MeshGeometry {
  /** Block type whose material supplies this group. */
  readonly type: BlockType;
  /** Texture layer for this group. */
  readonly texture: number;
  positions: number[];
  normals: number[];
  indices: number[];
  uvs: number[];
  colors: number[];
}

/** Extracts exact visible model surfaces, removing union interiors and faces hidden by solid neighbours. */
export function meshBlockModels(
  world: VoxelWorld,
  cx: number,
  cy: number,
  cz: number,
  solidOnly = false,
): BlockModelSurface[] {
  const chunk = world.getChunk(cx, cy, cz);
  if (!chunk) return [];
  const groups = new Map<string, BlockModelSurface>();
  for (let i = 0; i < 32768; i++) {
    const x = i & 31,
      y = i >> 10,
      z = (i >> 5) & 31,
      state = chunk.get(x, y, z),
      type = world.blocks.table[state & 65535];
    if (!type?.model || (solidOnly ? !type.solid : type.layer === 'invisible')) continue;
    const boxes = cellBoxes(type, state),
      cell = [cx * 32 + x, cy * 32 + y, cz * 32 + z];
    for (let k = 0; k < boxes.length; k++)
      for (let d = 0; d < 6; d++) {
        const box = boxes[k],
          a = d >> 1,
          u = (a + 1) % 3,
          v = (a + 2) % 3,
          positive = !(d & 1),
          plane = positive ? box.max[a] : box.min[a];
        let blockers = [...boxes];
        if (plane === (positive ? 1 : 0)) {
          const n = [...cell];
          n[a] += positive ? 1 : -1;
          const s = world.getBlock(n[0], n[1], n[2]),
            t = world.blocks.table[s & 65535];
          if (t && (solidOnly ? t.solid : t.layer === 'opaque' || t.id === type.id) && t.shape !== 'cross' && !t.liquid)
            blockers = blockers.concat(
              cellBoxes(t, s).map((b) => ({
                ...b,
                min: b.min.map((p, j) => p + (j === a ? (positive ? 1 : -1) : 0)) as [number, number, number],
                max: b.max.map((p, j) => p + (j === a ? (positive ? 1 : -1) : 0)) as [number, number, number],
              })),
            );
        }
        for (const rect of faceRectangles(box, d, blockers, k)) {
          const texture = box.textures[d],
            key = `${type.id}:${texture}`;
          let g = groups.get(key);
          if (!g)
            groups.set(key, (g = { type, texture, positions: [], normals: [], indices: [], uvs: [], colors: [] }));
          const base = g.positions.length / 3,
            clipped = {
              ...box,
              min: [...box.min] as [number, number, number],
              max: [...box.max] as [number, number, number],
            };
          clipped.min[u] = rect[0];
          clipped.min[v] = rect[1];
          clipped.max[u] = rect[2];
          clipped.max[v] = rect[3];
          const n = [...cell];
          n[a] += positive ? 1 : -1;
          const neighbor =
            world.getChunk(n[0] >> 5, n[1] >> 5, n[2] >> 5)?.getLight(n[0] & 31, n[1] & 31, n[2] & 31) ?? 0;
          const light = chunk.getLight(x, y, z),
            brightness = Math.max(light >> 4, light & 15, neighbor >> 4, neighbor & 15, type.light) / 15;
          for (let c = 0; c < 4; c++) {
            const p = faceCorner(clipped, d, c),
              fu = (p[u] - box.min[u]) / (box.max[u] - box.min[u]),
              fv = (p[v] - box.min[v]) / (box.max[v] - box.min[v]);
            g.positions.push(...p.map((n, j) => n + cell[j]));
            g.normals.push(
              a === 0 ? (positive ? 1 : -1) : 0,
              a === 1 ? (positive ? 1 : -1) : 0,
              a === 2 ? (positive ? 1 : -1) : 0,
            );
            const s = positive ? fu : fv,
              t = positive ? fv : fu,
              uv = box.uv[d];
            for (let j = 0; j < 2; j++)
              g.uvs.push(
                uv[j] * (1 - s) * (1 - t) + uv[2 + j] * s * (1 - t) + uv[4 + j] * s * t + uv[6 + j] * (1 - s) * t,
              );
            g.colors.push(brightness, brightness, brightness, 1);
          }
          g.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
      }
  }
  return [...groups.values()];
}
