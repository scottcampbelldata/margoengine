export const COUNT = 1_000_000;
export const SAMPLE_COUNT = 2048;
export const BUCKET_SIZE = 1000;
const MASK = (1 << 20) - 1;

// The operations are bijective on 20-bit words. Cycle-walking restricts that
// permutation to exactly a million unique values with no rejection bias.
export function valueAt(index, seed) {
  let value = index;
  do {
    value = (value + seed) & MASK;
    value ^= value >>> 11;
    value = Math.imul(value, 0x9e3779b1) & MASK;
    value ^= value >>> 9;
    value = Math.imul(value, 0x85ebca77) & MASK;
    value ^= value >>> 10;
  } while (value >= COUNT);
  return value;
}

export function samples(at) {
  const values = new Uint32Array(SAMPLE_COUNT);
  for (let i = 0; i < values.length; i++) {
    values[i] = at(Math.round(i * (COUNT - 1) / (values.length - 1)));
  }
  return values;
}

export function inspect(result) {
  if (!(result instanceof Uint32Array) || result.length !== COUNT) {
    throw new Error('The sort returned an unexpected array.');
  }
  const histogram = new Uint32Array(COUNT / BUCKET_SIZE);
  for (let index = 0; index < result.length; index++) {
    const value = result[index];
    if (value !== index) throw new Error('Wrong value at index ' + index.toLocaleString() + '.');
    histogram[Math.floor(value / BUCKET_SIZE)]++;
  }
  return { histogram, preview: samples(index => result[index]) };
}
