// Riders seated on a crowd of horses: each rider's root matrix from the horse's seat frame (`@margoengine/horses/crowd`
// `herd.saddles`, read back from the bone texture the GPU draws the horse with), the seat of `@margoengine/horses/seat`
// riderSeat (the hip joint above the seat bones, Winter's segment lengths) and the rider's own hip height, facing the
// horse's way with a share of the trunk's pitch, as mountRider seats a single rider. A crowd rider follows the saddle
// rigidly, without mountRider's damped spring, so every frame is a pure function of the horses and seeks exactly; the
// spring's lag is a few millimetres at the trot (Bystroem et al. 2009: the pelvis follows the saddle closely).

/** Options of {@link riderMatrix}. */
export interface RiderPlacement {
  /** The rider's hip joint above the seat point in the saddle frame, metres. Default 0.055 times the rider height (riderSeat). */
  readonly seatHip?: number;
  /** The rider model's hip joint above its root (its feet), model units at scale 1. Default 0.53 of `height`. */
  readonly hipHeight?: number;
  /** Rider standing height, model units. Default 1.75. */
  readonly height?: number;
  /** Share of the horse trunk's pitch the rider takes, 0 to 1. Default 0.4. */
  readonly pitchShare?: number;
  /** The rider model's facing: radians about +Y from +Z. Default 0 (glTF faces +Z). */
  readonly facing?: number;
}

/**
 * Where a rider's root goes (16 numbers, column-major) for a horse's seat frame (16 numbers at `at` in `saddles`) and a
 * rider scale. Pure.
 * @throws RangeError for options out of range.
 */
export function riderMatrix(
  saddles: ArrayLike<number>,
  at: number,
  scale = 1,
  placement: RiderPlacement = {},
  out: Float32Array = new Float32Array(16),
  outAt = 0,
): Float32Array {
  const height = placement.height ?? 1.75,
    seatHip = placement.seatHip ?? 0.055 * height,
    hipHeight = placement.hipHeight ?? 0.53 * height,
    share = placement.pitchShare ?? 0.4,
    facing = placement.facing ?? 0;
  if (!(height > 0) || !(seatHip >= 0 && seatHip < 1) || !(hipHeight > 0 && hipHeight < 5) || !(share >= 0 && share <= 1) || !Number.isFinite(facing) || !(scale > 0))
    throw new RangeError('riderMatrix needs a height above 0, seatHip 0 to 1 m, hipHeight 0 to 5, pitchShare 0 to 1, a finite facing and a scale above 0');
  const s = saddles,
    // The seat frame's forward axis gives the heading and the trunk's pitch (nose up positive).
    zx = s[at + 8]!,
    zy = s[at + 9]!,
    zz = s[at + 10]!,
    heading = Math.atan2(zx, zz),
    pitch = Math.atan2(zy, Math.hypot(zx, zz)) * share,
    ch = Math.cos(heading),
    sh = Math.sin(heading),
    cp = Math.cos(pitch),
    sp = Math.sin(pitch),
    // The rider's frame: forward f, up u, and x = u x f (+X the left, as the horse's).
    f = [sh * cp, sp, ch * cp],
    u = [-sh * sp, cp, -ch * sp],
    x = [u[1]! * f[2]! - u[2]! * f[1]!, u[2]! * f[0]! - u[0]! * f[2]!, u[0]! * f[1]! - u[1]! * f[0]!],
    // The hip: the seat point, then up the seat frame's own +Y by seatHip; the root hangs hipHeight below it along u.
    hx = s[at + 12]! + s[at + 4]! * seatHip * scale,
    hy = s[at + 13]! + s[at + 5]! * seatHip * scale,
    hz = s[at + 14]! + s[at + 6]! * seatHip * scale,
    cf = Math.cos(facing),
    sf = Math.sin(facing);
  // A model facing (sin facing, 0, cos facing) turns back by `facing` in the rider's frame, so its own forward lands on
  // f: x' = x cos + f sin, f' = f cos - x sin.
  for (let k = 0; k < 3; k++) {
    out[outAt + k] = (x[k]! * cf + f[k]! * sf) * scale;
    out[outAt + 4 + k] = u[k]! * scale;
    out[outAt + 8 + k] = (f[k]! * cf - x[k]! * sf) * scale;
  }
  out[outAt + 3] = out[outAt + 7] = out[outAt + 11] = 0;
  out[outAt + 12] = hx - u[0]! * hipHeight * scale;
  out[outAt + 13] = hy - u[1]! * hipHeight * scale;
  out[outAt + 14] = hz - u[2]! * hipHeight * scale;
  out[outAt + 15] = 1;
  return out;
}
