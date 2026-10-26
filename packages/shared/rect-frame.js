// The frame of a rectangle light, shared by clustered's AreaLights and the lightmap baker so both orient a
// RectAreaLight the same way: normal = direction / |direction|, right = up x normal (normalized), up' = normal x right.
// Callers check `direction` is nonzero and finite (and `up` finite) first.
export function rectFrame(direction, up, label) {
  const length = Math.hypot(direction[0], direction[1], direction[2]),
    n = [direction[0] / length, direction[1] / length, direction[2] / length],
    hint = up ?? (Math.abs(n[1]) > 0.999 ? [0, 0, 1] : [0, 1, 0]),
    r = [hint[1] * n[2] - hint[2] * n[1], hint[2] * n[0] - hint[0] * n[2], hint[0] * n[1] - hint[1] * n[0]],
    rl = Math.hypot(r[0], r[1], r[2]);
  if (!(rl > 1e-6 * Math.hypot(hint[0], hint[1], hint[2])))
    throw new RangeError(`${label} up is parallel to its direction; pass another up vector`);
  const right = [r[0] / rl, r[1] / rl, r[2] / rl];
  return {
    normal: n,
    right,
    up: [n[1] * right[2] - n[2] * right[1], n[2] * right[0] - n[0] * right[2], n[0] * right[1] - n[1] * right[0]],
  };
}
