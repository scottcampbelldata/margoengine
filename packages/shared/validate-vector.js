// The check every kinematics vector input passes: three finite numbers of magnitude at most 1e100. Shared by
// kinematics-constraints and robot-planning, which take the same vectors.
const MAX_MAGNITUDE = 1e100;
const checked = /* @__PURE__ */ new Float64Array(3);

/** Throws a TypeError unless `value` has three components, and a RangeError unless each is finite and within 1e100. */
export function validateVector(value, name = 'vector') {
  if (value instanceof Float64Array && value.length === 3) {
    checked[0] = value[0];
    checked[1] = value[1];
    checked[2] = value[2];
  } else if (value instanceof Float32Array && value.length === 3) {
    checked[0] = value[0];
    checked[1] = value[1];
    checked[2] = value[2];
  } else if (Array.isArray(value) && value.length === 3) {
    const x = value[0],
      y = value[1],
      z = value[2];
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number')
      throw new RangeError(`${name} must be finite with magnitude at most 1e100`);
    checked[0] = x;
    checked[1] = y;
    checked[2] = z;
  } else throw new TypeError(`${name} must have three components`);
  // Compared here, not in a call: passing a double to validateFinite boxes it whenever V8 did not inline the call, and
  // this runs for every proxy on every candidate pose. A comparison with NaN is false.
  const x = checked[0],
    y = checked[1],
    z = checked[2];
  if (
    !(x <= MAX_MAGNITUDE && x >= -MAX_MAGNITUDE && y <= MAX_MAGNITUDE && y >= -MAX_MAGNITUDE) ||
    !(z <= MAX_MAGNITUDE && z >= -MAX_MAGNITUDE)
  )
    throw new RangeError(`${name} must be finite with magnitude at most 1e100`);
}
