// Math.hypot for per-frame paths: V8's Math.hypot allocates an array for its arguments on every call.
/**
 * Terms and result of hypotOf: write up to four terms at 0 to 3, call hypotOf(count), read the result at 4. No number
 * crosses a call, so V8 boxes none: hypot's arguments and result become heap numbers whenever it is not inlined.
 */
export const hypotTerms = new Float64Array(5);
export function hypotOf(count) {
  // V8's own steps (the largest magnitude scales every term, then a Kahan sum), so V8 gets the same bits.
  const terms = hypotTerms;
  let max = 0,
    sum = 0,
    compensation = 0;
  for (let i = 0; i < count; i++) max = Math.max(max, (terms[i] = Math.abs(terms[i])));
  if (max === Infinity || !max) {
    terms[4] = max;
    return;
  }
  for (let i = 0; i < count; i++) {
    const n = terms[i] / max,
      summand = n * n - compensation,
      next = sum + summand;
    compensation = next - sum - summand;
    sum = next;
  }
  terms[4] = Math.sqrt(sum) * max;
}
export function hypot(count, a, b, c = 0, d = 0) {
  const terms = hypotTerms;
  terms[0] = a;
  terms[1] = b;
  terms[2] = c;
  terms[3] = d;
  hypotOf(count);
  return terms[4];
}
