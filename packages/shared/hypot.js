// Math.hypot for per-frame paths: V8's Math.hypot allocates an array for its arguments on every call.
/**
 * Terms and result of hypotOf: write up to four terms at 0 to 3, call hypotOf(count), read the result at 4. No number
 * crosses a call, so V8 boxes none: hypot's arguments and result become heap numbers whenever it is not inlined.
 */
export const hypotTerms = new Float64Array(5);
export function hypotOf(count) {
  // V8's own steps (the largest magnitude scales every term, then a Kahan sum), so V8 gets the same bits.
  const terms = hypotTerms;
  // The largest by a compare, not Math.max: V8 13 (Node 24) Maglev calls Math.max and boxes its numbers. As in
  // Math.hypot, an infinite term wins over a NaN one, and a NaN one over the rest.
  let max = 0,
    sum = 0,
    compensation = 0,
    nan = false;
  for (let i = 0; i < count; i++) {
    const term = (terms[i] = Math.abs(terms[i]));
    if (term > max) max = term;
    else if (term !== term) nan = true;
  }
  if (max === Infinity || nan || !max) {
    terms[4] = max === Infinity || !nan ? max : Number.NaN;
    return;
  }
  for (let i = 0; i < count; i++) {
    const n = terms[i] / max,
      summand = n * n - compensation,
      next = sum + summand;
    compensation = next - sum - summand;
    sum = next;
  }
  // Through the array: V8 13 Maglev boxes Math.sqrt's argument, and fed from the loop it boxed the sum at every step.
  terms[4] = sum;
  terms[4] = Math.sqrt(terms[4]) * max;
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
