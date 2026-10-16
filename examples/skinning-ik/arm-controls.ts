type Point = [number, number, number];
type Knot = readonly [parameter: number, x: number, y: number, z: number];
export type ArmControl = 'side' | 'height' | 'nearFar';

// Model-local orb centers, not Cartesian offsets. Every track passes the
// authored held-orb pose halfway through its range. Moving one control selects
// its complete track; unrelated slider positions never compose a distant pose.
const home = [-0.4800001382827759, 1.1699998426437377, -0.2300000339746475] as const;
const tracks: Record<ArmControl, readonly Knot[]> = {
  side: [
    [0, -0.76, 1.16, -0.03],
    [0.5, ...home],
    [0.75, -0.1, 1.16, -0.43],
    [0.88, 0.12, 1.16, -0.42],
    // The torso assist turns the shoulder and its collision frame together
    // for this opposite-edge reach; the bone lengths remain unchanged.
    [1, 0.235, 1.16, -0.3],
  ],
  height: [
    [0, -0.36, 0.66, -0.02],
    [0.5, ...home],
    // Clear the side of the head before folding inward above it.
    [0.82, -0.48, 1.54, -0.23],
    [1, -0.24, 1.69, 0],
  ],
  nearFar: [
    [0, -0.4, 1.16, 0.2],
    [0.25, -0.4, 0.7, -0.05],
    [0.5, ...home],
    [1, -0.37, 1.16, -0.5],
  ],
};

function trackFor(control: ArmControl): readonly Knot[] {
  const track = tracks[control];
  if (!track) throw new RangeError('Unknown arm control');
  return track;
}

/** Select one complete, smooth motion track in the robot model's local frame. */
export function mapArmControl<T extends { [index: number]: number } = Point>(
  control: ArmControl,
  parameter: number,
  out: T = [0, 0, 0] as unknown as T,
): T {
  if (!Number.isFinite(parameter)) throw new RangeError('Arm control parameter must be finite');
  const track = trackFor(control),
    t = Math.max(0, Math.min(1, parameter));
  let index = 1;
  while (index < track.length - 1 && t > track[index][0]) index++;
  const a = track[index - 1],
    b = track[index],
    u = (t - a[0]) / (b[0] - a[0]),
    blend = u * u * (3 - 2 * u);
  for (let axis = 0; axis < 3; axis++)
    out[axis] =
      blend === 0 ? a[axis + 1] : blend === 1 ? b[axis + 1] : a[axis + 1] + (b[axis + 1] - a[axis + 1]) * blend;
  return out;
}

/** Nearest point on a track after a free drag or preset, for honest slider readouts. */
export function nearestArmControlParameter(control: ArmControl, point: ArrayLike<number>): number {
  if (!Number.isFinite(point[0]) || !Number.isFinite(point[1]) || !Number.isFinite(point[2]))
    throw new RangeError('Arm control point must be finite');
  const track = trackFor(control);
  let bestDistance = Infinity,
    bestParameter = 0;
  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1],
      b = track[i],
      dx = b[1] - a[1],
      dy = b[2] - a[2],
      dz = b[3] - a[3];
    const blend = Math.max(
      0,
      Math.min(
        1,
        ((point[0] - a[1]) * dx + (point[1] - a[2]) * dy + (point[2] - a[3]) * dz) / (dx * dx + dy * dy + dz * dz),
      ),
    );
    const x = a[1] + dx * blend - point[0],
      y = a[2] + dy * blend - point[1],
      z = a[3] + dz * blend - point[2],
      distance = x * x + y * y + z * z;
    if (distance < bestDistance) {
      bestDistance = distance;
      // Inverse of smoothstep on [0,1], including exact endpoints.
      const u = blend === 0 || blend === 1 ? blend : 0.5 - Math.sin(Math.asin(1 - 2 * blend) / 3);
      bestParameter = a[0] + (b[0] - a[0]) * u;
    }
  }
  return bestParameter;
}
