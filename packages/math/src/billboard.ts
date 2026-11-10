// Camera-facing rotations for billboard meshes (Crocotile object billboards). The mesh's front faces its local +Z.
import { Quaternion } from './quaternion.js';
import { multiplyQuaternions } from './quat.js';
import type { Mat4, MutableVec3, Vec3 } from './types.js';
import { finiteVector } from './validate.js';
import { cross } from './vec3.js';

/** Options for {@link billboardRotation}. */
export interface BillboardOptions {
  /**
   * `'direction'` (default) turns the front opposite the camera's forward vector, so the billboard is parallel to the
   * view plane; `'position'` turns it toward the camera position.
   */
  mode?: 'direction' | 'position';
  /** Keep the billboard upright: turn about world +Y only, so its up stays +Y. Default false. */
  lockY?: boolean;
  /** Round the yaw about world +Y to multiples of this many degrees; 0 (default) is off. */
  snap?: number;
  /**
   * World matrix of the billboard's parent. The result is then the local rotation to give the mesh, so its world
   * rotation still faces the camera. The parent's rotation is read from its normalized axes (rotation and uniform scale).
   */
  parent?: Mat4;
}

type Q = [x: number, y: number, z: number, w: number];

const unit = (x: number, y: number, z: number): MutableVec3 | null => {
  const l = Math.hypot(x, y, z);
  return l > 1e-9 ? [x / l, y / l, z / l] : null;
};
const basis = (x: Vec3, y: Vec3, z: Vec3): Q => {
  const q = new Quaternion().setFromRotationMatrix({
    elements: [x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]],
  });
  return [q.x, q.y, q.z, q.w];
};
/** The three normalized axis columns of a column-major 4x4 matrix. */
const axes = (m: Mat4, name: string): [MutableVec3, MutableVec3, MutableVec3] => {
  const x = unit(m[0], m[1], m[2]),
    y = unit(m[4], m[5], m[6]),
    z = unit(m[8], m[9], m[10]);
  if (!x || !y || !z) throw new RangeError(`${name} matrix has a zero axis; pass a rotation (and scale) world matrix`);
  // A mirror (negative determinant) has no rotation quaternion: basis() would return one of length ~0.7.
  if (x[0] * (y[1] * z[2] - y[2] * z[1]) + y[0] * (z[1] * x[2] - z[2] * x[1]) + z[0] * (x[1] * y[2] - x[2] * y[1]) <= 0)
    throw new RangeError(
      `${name} matrix mirrors (negative determinant); a billboard needs a rotation (and scale) matrix`,
    );
  return [x, y, z];
};
const yawQuaternion = (angle: number): Q => [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];

/**
 * World rotation `[x, y, z, w]` for a billboard mesh at world `position`, whose front faces its local +Z, given the
 * camera's world matrix (column-major; columns 0 to 2 are its right, up and back axes, the camera looking down its
 * -Z, and column 3 is its position). `'direction'` mode copies the camera's orientation; `'position'` mode turns +Z
 * toward the camera and keeps the camera's up as close as it can. With `lockY` only the yaw remains; when the facing
 * is vertical (camera straight above) the yaw comes from the camera's back, then its down axis. `snap` rounds that
 * yaw. With `parent`, the result is the local rotation to set with `mesh.setQuaternion`.
 */
export function billboardRotation(
  camera: Mat4,
  position: Vec3,
  options: BillboardOptions = {},
): [x: number, y: number, z: number, w: number] {
  const { mode = 'direction', lockY = false, snap = 0, parent } = options;
  finiteVector(camera, 16, 'Billboard camera');
  finiteVector(position, 3, 'Billboard position');
  if (mode !== 'direction' && mode !== 'position')
    throw new TypeError("Billboard mode must be 'direction' or 'position'");
  if (!(snap >= 0 && snap < Infinity)) throw new RangeError('Billboard snap must be finite degrees >= 0 (0 is off)');
  if (parent) finiteVector(parent, 16, 'Billboard parent');
  const [cx, cy, cz] = axes(camera, 'Billboard camera'),
    // The way the billboard's +Z must point; a camera at the billboard's position falls back to the camera's back.
    z =
      (mode === 'position' && unit(camera[12] - position[0], camera[13] - position[1], camera[14] - position[2])) || cz;
  // Yaw of the facing about world +Y, from the first candidate that is not vertical.
  const flat = unit(z[0], 0, z[2]) ?? unit(cz[0], 0, cz[2]) ?? unit(-cy[0], 0, -cy[2]) ?? [0, 0, 1],
    yaw = Math.atan2(flat[0], flat[2]),
    step = (snap * Math.PI) / 180,
    turn = step ? Math.round(yaw / step) * step - yaw : 0;
  let q: Q;
  if (lockY) q = yawQuaternion(yaw + turn);
  else {
    const x = unit(...cross(cy, z)) ?? cx;
    q = basis(x, cross(z, x), z);
    if (turn) q = multiplyQuaternions(yawQuaternion(turn), q);
  }
  if (!parent) return q;
  const p = basis(...axes(parent, 'Billboard parent'));
  return multiplyQuaternions([-p[0], -p[1], -p[2], p[3]], q);
}

/** The eight directional-animation suffixes (`walk_N` ... `walk_NW`), named the way the object appears to face on screen. */
export type BillboardDirection = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';

// Direction j shows around camera azimuth 180 + 45 j degrees (0 is in front, 90 at the object's local +X).
const DIRECTIONS: readonly BillboardDirection[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/**
 * Which 8-direction animation to show for an object facing `facing` (world direction of its front, its logical +Z
 * before billboarding) seen from `toCamera` (world direction from the object to the camera; in `'direction'` mode pass
 * the camera's back axis). Sprite-sheet convention, measured about world +Y: a camera in front shows `'S'` (the object
 * faces the viewer), behind it `'N'`, at the object's left (its local +X, where it appears to face screen-left) `'W'`
 * and at its right `'E'`; each covers 45 degrees. `available` limits the choice to the suffixes an animation set has
 * (default all eight, N to NW): the nearest wins and an exact tie goes to the earlier entry. A vertical `toCamera`
 * counts as in front.
 */
export function billboardDirection(
  facing: Vec3,
  toCamera: Vec3,
  available: readonly BillboardDirection[] = DIRECTIONS,
): BillboardDirection {
  finiteVector(facing, 3, 'Billboard facing');
  finiteVector(toCamera, 3, 'Billboard toCamera');
  const f = unit(facing[0], 0, facing[2]);
  if (!f) throw new RangeError('Billboard facing must not be vertical; pass the direction the object faces');
  if (!available.length || available.some((d) => !DIRECTIONS.includes(d)))
    throw new TypeError('Billboard available directions must be a non-empty list of N, NE, E, SE, S, SW, W, NW');
  // Camera azimuth in 45-degree units, in the object's frame: z along its front, x along up x front.
  const x = toCamera[0] * f[2] - toCamera[2] * f[0],
    z = toCamera[0] * f[0] + toCamera[2] * f[2],
    sector = (Math.atan2(x, z) * 4) / Math.PI;
  let best = available[0],
    distance = Infinity;
  for (const d of available) {
    // Circular distance to the direction's azimuth, 0..4 units.
    const gap = Math.abs(((((sector - 4 - DIRECTIONS.indexOf(d)) % 8) + 12) % 8) - 4);
    if (gap < distance) {
      distance = gap;
      best = d;
    }
  }
  return best;
}
