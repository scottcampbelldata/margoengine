// Math.hypot for per-frame paths: V8's Math.hypot allocates an array for its arguments on every call.
const terms = new Float64Array(4);
export function hypot(count, a, b, c = 0, d = 0) {
  // V8's own steps (the largest magnitude scales every term, then a Kahan sum), so V8 gets the same bits.
  let max = 0,
    sum = 0,
    compensation = 0;
  terms[0] = Math.abs(a);
  terms[1] = Math.abs(b);
  terms[2] = Math.abs(c);
  terms[3] = Math.abs(d);
  for (let i = 0; i < count; i++) max = Math.max(max, terms[i]);
  if (max === Infinity || !max) return max;
  for (let i = 0; i < count; i++) {
    const n = terms[i] / max,
      summand = n * n - compensation,
      next = sum + summand;
    compensation = next - sum - summand;
    sum = next;
  }
  return Math.sqrt(sum) * max;
}
