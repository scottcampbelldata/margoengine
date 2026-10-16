// Demo-private length kernels. Keep the normalized, compensated operation order
// used by V8 Math.hypot, while writing through a retained Float64 destination.
// https://github.com/v8/v8/blob/main/src/builtins/math.tq
export function hypot3Into(value: ArrayLike<number>, out: Float64Array, slot = 0): void {
  const x = Math.abs(value[0]),
    y = Math.abs(value[1]),
    z = Math.abs(value[2]);
  if (x === Infinity || y === Infinity || z === Infinity) {
    out[slot] = Infinity;
    return;
  }
  const largest = Math.max(Math.max(x, y), z);
  if (largest !== largest) {
    out[slot] = NaN;
    return;
  }
  if (largest === 0) {
    out[slot] = 0;
    return;
  }
  const first = (x / largest) * (x / largest),
    second = (y / largest) * (y / largest),
    correction = first + second - first - second,
    third = (z / largest) * (z / largest) - correction;
  out[slot] = Math.sqrt(first + second + third) * largest;
}

export function hypot4Into(value: ArrayLike<number>, out: Float64Array, slot = 0): void {
  const x = Math.abs(value[0]),
    y = Math.abs(value[1]),
    z = Math.abs(value[2]),
    w = Math.abs(value[3]);
  if (x === Infinity || y === Infinity || z === Infinity || w === Infinity) {
    out[slot] = Infinity;
    return;
  }
  const largest = Math.max(Math.max(x, y), Math.max(z, w));
  if (largest !== largest) {
    out[slot] = NaN;
    return;
  }
  if (largest === 0) {
    out[slot] = 0;
    return;
  }
  let sum = 0,
    correction = 0;
  for (let i = 0; i < 4; i++) {
    const component = (i === 0 ? x : i === 1 ? y : i === 2 ? z : w) / largest,
      adjusted = component * component - correction,
      next = sum + adjusted;
    correction = next - sum - adjusted;
    sum = next;
  }
  out[slot] = Math.sqrt(sum) * largest;
}
