import { splitNodeMatrix as split } from '@margoengine/math/quat';

/** What splitTRS returns, written here so the declarations of this package do not name @margoengine/math. */
type NodeSplit =
  | {
      ok: true;
      position: [number, number, number];
      rotation: [number, number, number, number];
      scale: [number, number, number];
    }
  | { ok: false; reason: 'singular' | 'shear' };

/**
 * `splitTRS` for a glTF node `matrix`, plus the zero scales glTF 2.0 section 3.5.3 allows: a column whose float32
 * values are all zero is a zero scale on that axis (`splitNodeMatrix` of `@margoengine/math/quat`).
 */
export const splitNodeMatrix = (m: ArrayLike<number>): NodeSplit => split(m, { float32: true });
