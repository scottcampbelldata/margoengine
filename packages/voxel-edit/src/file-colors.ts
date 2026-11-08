// Shared pieces of the voxel file readers: byte views, cut-off errors and the true-colour to palette reduction.
import type { Vec3 } from '@margoengine/math';
import type { VoxelFile, VoxelFileModel } from './formats.js';
import { sizeCells } from './grid.js';

/** @internal Most models one file may hold. */
export const MAX_MODELS = 4096;

export const view = (bytes: unknown, subject: string): Uint8Array => {
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (bytes instanceof Uint8Array) return bytes;
  throw new TypeError(`${subject} needs a Uint8Array or ArrayBuffer; pass the file's bytes`);
};
export const short = (subject: string): never => {
  throw new RangeError(`${subject} ends early; the file is cut off, export it again`);
};

/** Turns RGBA cells (0 is air) into grids sharing one palette, coarsening colours only when over 255 are used. */
export class Colors {
  private readonly models: { name?: string; position: Vec3; size: Vec3; cells: Uint32Array }[] = [];
  private used = 0;
  constructor(private readonly limit: number) {}
  add(size: Vec3, position: Vec3, name: string | undefined, subject: string): Uint32Array {
    if (this.models.length >= MAX_MODELS)
      throw new RangeError(`${subject} holds over ${MAX_MODELS} models; split the file`);
    this.used += sizeCells(size, this.limit - this.used, `${subject} size`);
    const cells = new Uint32Array(size[0] * size[1] * size[2]);
    this.models.push({ name, position, size, cells });
    return cells;
  }
  finish(): VoxelFile {
    const seen = new Set<number>();
    for (const { cells } of this.models) for (const cell of cells) if (cell) seen.add(cell);
    let drop = 0,
      coarse = (color: number) => color;
    while (new Set([...seen].map(coarse)).size > 255) {
      const bits = ++drop,
        half = 1 << (bits - 1),
        channel = (v: number) => (v === 255 ? 255 : ((v >> bits) << bits) | half);
      coarse = (color) =>
        (channel(color & 255) |
          (channel((color >>> 8) & 255) << 8) |
          (channel((color >>> 16) & 255) << 16) |
          (channel(color >>> 24) << 24)) >>>
        0;
    }
    const palette = new Uint8Array(1024),
      indexes = new Map<number, number>(),
      models: VoxelFileModel[] = this.models.map(({ name, position, size, cells }) => {
        const voxels = new Uint8Array(cells.length);
        cells.forEach((cell, i) => {
          if (!cell) return;
          const color = coarse(cell);
          let index = indexes.get(color);
          if (index === undefined) {
            index = indexes.size + 1;
            indexes.set(color, index);
            new DataView(palette.buffer).setUint32(index * 4, color, true);
          }
          voxels[i] = index;
        });
        return { ...(name === undefined ? {} : { name }), position, grid: { size, voxels } };
      });
    return { models, palette, colorsReduced: drop > 0 };
  }
}
export const rgba = (r: number, g: number, b: number, a: number) => (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;
