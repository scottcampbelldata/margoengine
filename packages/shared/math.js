export function invert(out, m, offset = 0, workspace) {
  if (!out || out.length < 16 || !m || !Number.isSafeInteger(offset) || offset < 0 || m.length < offset + 16) return false;
  const a = workspace ?? new Float64Array(52);
  if (!(a instanceof Float64Array) || a.length < 52 || a.buffer === out.buffer || a.buffer === m.buffer) return false;
  for (let r = 0; r < 4; r++) {
    let scale = 0;
    for (let c = 0; c < 8; c++) { const v = c < 4 ? m[offset + c * 4 + r] : +(c - 4 === r); if (!Number.isFinite(v)) return false; a[r * 8 + c] = v; if (c < 4) scale = Math.max(scale, Math.abs(v)); }
    if (!scale) return false; a[32 + r] = scale;
  }
  for (let c = 0; c < 4; c++) {
    let pivot = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[r * 8 + c]) / a[32 + r] > Math.abs(a[pivot * 8 + c]) / a[32 + pivot]) pivot = r;
    if (a[pivot * 8 + c] === 0 || !Number.isFinite(a[pivot * 8 + c])) return false;
    for (let k = 0; k < 8; k++) { const value = a[c * 8 + k]; a[c * 8 + k] = a[pivot * 8 + k]; a[pivot * 8 + k] = value; }
    const scale = a[32 + c]; a[32 + c] = a[32 + pivot]; a[32 + pivot] = scale;
    const d = a[c * 8 + c]; for (let k = 0; k < 8; k++) a[c * 8 + k] /= d;
    for (let r = 0; r < 4; r++) if (r !== c) { const f = a[r * 8 + c]; for (let k = 0; k < 8; k++) a[r * 8 + k] -= f * a[c * 8 + k]; }
  }
  for (let i = 0; i < 16; i++) { const v = a[(i % 4) * 8 + (i >> 2) + 4]; if (!Number.isFinite(v) || out instanceof Float32Array && !Number.isFinite(Math.fround(v))) return false; a[36 + i] = v; }
  for (let i = 0; i < 16; i++) out[i] = a[36 + i];
  return true;
}

export function finiteVector(v, size, name) {
  if (!v || v.length !== size) throw new TypeError(`${name} must contain ${size} finite numbers`);
  for (let i = 0; i < size; i++) if (!Number.isFinite(v[i]) || !Number.isFinite(Math.fround(v[i]))) throw new TypeError(`${name} must contain ${size} finite Float32 numbers`);
}
