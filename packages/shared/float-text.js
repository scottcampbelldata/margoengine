// The text the exporters write for a number: the shortest decimal that reads back as the same Float32.
// Recently written values: meshes repeat most of theirs (shared corners, axis normals, UVs). Cleared when full.
const numCache = new Map(),
  numBits = new Uint32Array(new Float32Array(1).buffer),
  numFloat = new Float32Array(numBits.buffer);
/** The fewest significant digits (1 to 9) whose toPrecision text reads back as `f`, and that text as a number. */
function shortest(f) {
  // Integers below 2^24 are exact and distinct in Float32, so their shortest text is the integer itself.
  if (Number.isInteger(f) && Math.abs(f) < 16_777_216) return String(f);
  const fits = (digits) => Math.fround(Number(f.toPrecision(digits))) === f;
  numFloat[0] = f;
  const exponent = (numBits[0] >>> 23) & 255;
  // Away from a power of two, f's rounding interval is symmetric, so a correctly rounded text with more digits is never
  // farther from f: once some digit count reads back, every larger one does, and a binary search finds the fewest (3 or
  // 4 toPrecision calls instead of up to 9). A power of two (zero mantissa), the top binade, NaN and infinity have a
  // lopsided or open interval: they scan every count.
  if (numBits[0] & 0x7fffff && exponent > 0 && exponent < 254) {
    let low = 1,
      high = 9; // nine significant digits always identify a Float32
    while (low < high) {
      const mid = (low + high) >> 1;
      if (fits(mid)) high = mid;
      else low = mid + 1;
    }
    return String(Number(f.toPrecision(low)));
  }
  for (let digits = 1; digits < 10; digits++) if (fits(digits)) return String(Number(f.toPrecision(digits)));
  return String(f);
}
/** Shortest decimal that reads back as the same Float32 value. */
export function num(value) {
  const f = Math.fround(value);
  if (f === 0) return '0';
  let text = numCache.get(f);
  if (text === undefined) {
    text = shortest(f);
    if (numCache.size >= 8192) numCache.clear();
    numCache.set(f, text);
  }
  return text;
}
