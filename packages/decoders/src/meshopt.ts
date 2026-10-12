// EXT_meshopt_compression decoding: a pure TypeScript port of the meshoptimizer reference decoder
// (vertex codec v0, index codec v0/v1, index sequence, OCTAHEDRAL/QUATERNION/EXPONENTIAL filters).
// Output matches the reference SIMD decoder bit for bit. Synchronous and dependency-free.

function meshoptDecodeBytes(src: Uint8Array, pos: number, end: number, buffer: Uint8Array, size: number): number {
  const headerSize = ((size >> 4) + 3) >> 2;
  if (end - pos < headerSize) throw new Error('EXT_meshopt_compression: truncated vertex stream');
  const hdr = pos;
  pos += headerSize;
  for (let i = 0; i < size; i += 16) {
    if (end - pos < 24) throw new Error('EXT_meshopt_compression: truncated vertex stream');
    const gi = i >> 4;
    const bits = (src[hdr + (gi >> 2)] >> ((gi & 3) << 1)) & 3;
    if (bits === 0) {
      buffer.fill(0, i, i + 16);
    } else if (bits === 1) {
      let v = pos + 4;
      for (let b = 0; b < 4; b++) {
        const byte = src[pos + b];
        for (let s = 6; s >= 0; s -= 2) {
          const enc = (byte >> s) & 3;
          if (enc === 3) buffer[i + b * 4 + ((6 - s) >> 1)] = src[v++];
          else buffer[i + b * 4 + ((6 - s) >> 1)] = enc;
        }
      }
      pos = v;
    } else if (bits === 2) {
      let v = pos + 8;
      for (let b = 0; b < 8; b++) {
        const byte = src[pos + b];
        const hi = byte >> 4, lo = byte & 15;
        buffer[i + b * 2] = hi === 15 ? src[v++] : hi;
        buffer[i + b * 2 + 1] = lo === 15 ? src[v++] : lo;
      }
      pos = v;
    } else {
      buffer.set(src.subarray(pos, pos + 16), i);
      pos += 16;
    }
  }
  return pos;
}

/** meshopt vertex codec, version 0 (the version EXT_meshopt_compression allows). */
export function meshoptDecodeVertexBuffer(target: Uint8Array, count: number, size: number, src: Uint8Array): void {
  if (size <= 0 || size > 256 || size % 4 !== 0) throw new Error(`EXT_meshopt_compression: invalid ATTRIBUTES byteStride ${size}`);
  if (src.length < 1 + size) throw new Error('EXT_meshopt_compression: truncated vertex stream');
  const header = src[0];
  if ((header & 0xf0) !== 0xa0) throw new Error('EXT_meshopt_compression: bad vertex stream header');
  if ((header & 0x0f) !== 0) throw new Error(`EXT_meshopt_compression: vertex codec version ${header & 0x0f} is not supported (only version 0)`);
  const end = src.length;
  const last = src.slice(end - size);
  let blockMax = Math.floor(8192 / size) & ~15;
  if (blockMax > 256) blockMax = 256;
  const buffer = new Uint8Array(256);
  let pos = 1;
  for (let vo = 0; vo < count; vo += blockMax) {
    const bc = Math.min(blockMax, count - vo);
    const aligned = (bc + 15) & ~15;
    for (let k = 0; k < size; k++) {
      pos = meshoptDecodeBytes(src, pos, end, buffer, aligned);
      let p = last[k];
      let o = vo * size + k;
      for (let i = 0; i < bc; i++) {
        const d = buffer[i];
        p = (p + ((d >> 1) ^ -(d & 1))) & 255;
        target[o] = p;
        o += size;
      }
      last[k] = p;
    }
  }
  const tail = size < 32 ? 32 : size;
  if (end - pos !== tail) throw new Error('EXT_meshopt_compression: vertex stream has trailing or missing data');
}

function meshoptVByte(src: Uint8Array, st: { p: number }): number {
  const lead = src[st.p++];
  if (lead < 128) return lead;
  let result = lead & 127;
  let shift = 7;
  for (let i = 0; i < 4; i++) {
    const g = src[st.p++];
    result |= (g & 127) << shift;
    shift += 7;
    if (g < 128) break;
  }
  return result >>> 0;
}

/** meshopt triangle index codec (versions 0 and 1). */
export function meshoptDecodeIndexBuffer(out: Uint32Array | Uint16Array, count: number, src: Uint8Array): void {
  if (count % 3 !== 0) throw new Error('EXT_meshopt_compression: TRIANGLES count must be a multiple of 3');
  if (src.length < 1 + count / 3 + 16) throw new Error('EXT_meshopt_compression: truncated index stream');
  if ((src[0] & 0xf0) !== 0xe0) throw new Error('EXT_meshopt_compression: bad index stream header');
  const version = src[0] & 0x0f;
  if (version > 1) throw new Error(`EXT_meshopt_compression: index codec version ${version} is not supported`);
  const edge = new Uint32Array(32).fill(0xffffffff);
  const vfifo = new Uint32Array(16).fill(0xffffffff);
  let eo = 0, vo = 0, next = 0, last = 0;
  const fecmax = version >= 1 ? 13 : 15;
  let code = 1;
  const st = { p: 1 + count / 3 };
  const safeEnd = src.length - 16;
  const aux = safeEnd;
  for (let i = 0; i < count; i += 3) {
    if (st.p > safeEnd) throw new Error('EXT_meshopt_compression: truncated index stream');
    const codetri = src[code++];
    let a: number, b: number, c: number;
    if (codetri < 0xf0) {
      const fe = codetri >> 4;
      const ei = ((eo - 1 - fe) & 15) * 2;
      a = edge[ei]; b = edge[ei + 1];
      const fec = codetri & 15;
      if (fec < fecmax) {
        c = fec === 0 ? next : vfifo[(vo - 1 - fec) & 15];
        const f0 = fec === 0 ? 1 : 0;
        next += f0;
        vfifo[vo] = c; vo = (vo + f0) & 15;
      } else {
        if (fec !== 15) c = (last + (fec - (fec ^ 3))) >>> 0;
        else { const v = meshoptVByte(src, st); c = (last + ((v >>> 1) ^ -(v & 1))) >>> 0; }
        last = c;
        vfifo[vo] = c; vo = (vo + 1) & 15;
      }
      edge[eo * 2] = c; edge[eo * 2 + 1] = b; eo = (eo + 1) & 15;
      edge[eo * 2] = a; edge[eo * 2 + 1] = c; eo = (eo + 1) & 15;
    } else if (codetri < 0xfe) {
      const codeaux = src[aux + (codetri & 15)];
      const feb = codeaux >> 4, fec = codeaux & 15;
      a = next++;
      b = feb === 0 ? next : vfifo[(vo - feb) & 15];
      const fb0 = feb === 0 ? 1 : 0;
      next += fb0;
      c = fec === 0 ? next : vfifo[(vo - fec) & 15];
      const fc0 = fec === 0 ? 1 : 0;
      next += fc0;
      vfifo[vo] = a; vo = (vo + 1) & 15;
      vfifo[vo] = b; vo = (vo + fb0) & 15;
      vfifo[vo] = c; vo = (vo + fc0) & 15;
      edge[eo * 2] = b; edge[eo * 2 + 1] = a; eo = (eo + 1) & 15;
      edge[eo * 2] = c; edge[eo * 2 + 1] = b; eo = (eo + 1) & 15;
      edge[eo * 2] = a; edge[eo * 2 + 1] = c; eo = (eo + 1) & 15;
    } else {
      const codeaux = src[st.p++];
      const fea = codetri === 0xfe ? 0 : 15;
      const feb = codeaux >> 4, fec = codeaux & 15;
      if (codeaux === 0) next = 0;
      a = fea === 0 ? next++ : 0;
      b = feb === 0 ? next++ : vfifo[(vo - feb) & 15];
      c = fec === 0 ? next++ : vfifo[(vo - fec) & 15];
      if (fea === 15) { const v = meshoptVByte(src, st); last = a = (last + ((v >>> 1) ^ -(v & 1))) >>> 0; }
      if (feb === 15) { const v = meshoptVByte(src, st); last = b = (last + ((v >>> 1) ^ -(v & 1))) >>> 0; }
      if (fec === 15) { const v = meshoptVByte(src, st); last = c = (last + ((v >>> 1) ^ -(v & 1))) >>> 0; }
      vfifo[vo] = a; vo = (vo + 1) & 15;
      vfifo[vo] = b; vo = (vo + (feb === 0 || feb === 15 ? 1 : 0)) & 15;
      vfifo[vo] = c; vo = (vo + (fec === 0 || fec === 15 ? 1 : 0)) & 15;
      edge[eo * 2] = b; edge[eo * 2 + 1] = a; eo = (eo + 1) & 15;
      edge[eo * 2] = c; edge[eo * 2 + 1] = b; eo = (eo + 1) & 15;
      edge[eo * 2] = a; edge[eo * 2 + 1] = c; eo = (eo + 1) & 15;
    }
    out[i] = a; out[i + 1] = b; out[i + 2] = c;
  }
  if (st.p !== safeEnd) throw new Error('EXT_meshopt_compression: index stream has trailing or missing data');
}

/** meshopt index sequence codec. */
export function meshoptDecodeIndexSequence(out: Uint32Array | Uint16Array, count: number, src: Uint8Array): void {
  if (src.length < 1 + count + 4) throw new Error('EXT_meshopt_compression: truncated index sequence');
  if ((src[0] & 0xf0) !== 0xd0) throw new Error('EXT_meshopt_compression: bad index sequence header');
  const version = src[0] & 0x0f;
  if (version > 1) throw new Error(`EXT_meshopt_compression: index sequence version ${version} is not supported`);
  const safeEnd = src.length - 4;
  const st = { p: 1 };
  let last0 = 0, last1 = 0;
  for (let i = 0; i < count; i++) {
    if (st.p >= safeEnd) throw new Error('EXT_meshopt_compression: truncated index sequence');
    let v = meshoptVByte(src, st);
    const cur = v & 1;
    v >>>= 1;
    const d = (v >>> 1) ^ -(v & 1);
    if (cur) { last1 = (last1 + d) >>> 0; out[i] = last1; } else { last0 = (last0 + d) >>> 0; out[i] = last0; }
  }
  if (st.p !== safeEnd) throw new Error('EXT_meshopt_compression: index sequence has trailing or missing data');
}

const fr = Math.fround;

function meshoptFilterOct(data: Int8Array | Int16Array, count: number): void {
  // Same arithmetic order and rounding as the reference SIMD decoder (bit-identical output).
  const max = data instanceof Int8Array ? 127 : 32767;
  for (let i = 0; i < count; i++) {
    let x = data[i * 4], y = data[i * 4 + 1];
    const z = data[i * 4 + 2] - (Math.abs(x) + Math.abs(y)); // small integers: exact
    const t = z < 0 ? z : 0;
    x = x + (x < 0 ? -t : t);
    y = y + (y < 0 ? -t : t);
    const ll = fr(fr(x * x) + fr(fr(y * y) + fr(z * z)));
    const s = fr(max / fr(Math.sqrt(ll)));
    data[i * 4] = snap(x * s);
    data[i * 4 + 1] = snap(y * s);
    data[i * 4 + 2] = snap(z * s);
  }
}

// Round a float32 to the nearest integer, ties to even (the "3 << 22" snap trick the SIMD
// reference decoder uses). Valid for |v| < 2^22.
const SNAP = 3 << 22;
function snap(v: number): number {
  return fr(fr(v) + SNAP) - SNAP;
}

function meshoptFilterQuat(data: Int16Array, count: number): void {
  // Same arithmetic order and rounding as the reference SIMD decoder (the one browsers and
  // Node run), so results are bit-identical: x/y/z/w are reconstructed unscaled, then scaled once.
  const scale = fr(32767 / fr(Math.SQRT2));
  for (let i = 0; i < count; i++) {
    const q3 = data[i * 4 + 3];
    const s = q3 | 3;
    const x = data[i * 4], y = data[i * 4 + 1], z = data[i * 4 + 2];
    const ws = fr(s * fr(s + s));
    const ww = fr(ws - fr(fr(x * x) + fr(fr(y * y) + fr(z * z))));
    const w = fr(Math.sqrt(ww >= 0 ? ww : 0));
    const ss = fr(scale / s);
    const qc = q3 & 3;
    data[i * 4 + ((qc + 1) & 3)] = snap(x * ss);
    data[i * 4 + ((qc + 2) & 3)] = snap(y * ss);
    data[i * 4 + ((qc + 3) & 3)] = snap(z * ss);
    data[i * 4 + (qc & 3)] = snap(w * ss);
  }
}

function meshoptFilterExp(u32: Uint32Array, f32: Float32Array, count: number): void {
  for (let i = 0; i < count; i++) {
    const v = u32[i];
    const m = (v << 8) >> 8;
    const e = v >> 24;
    f32[i] = m * Math.pow(2, e);
  }
}

/** Decode one EXT_meshopt_compression bufferView payload. */
export function meshoptDecodeGltfBuffer(src: Uint8Array, count: number, stride: number, mode: string, filter = 'NONE'): Uint8Array {
  const out = new Uint8Array(count * stride);
  if (mode === 'ATTRIBUTES') {
    meshoptDecodeVertexBuffer(out, count, stride, src);
  } else if (mode === 'TRIANGLES' || mode === 'INDICES') {
    if (stride !== 2 && stride !== 4) throw new Error(`EXT_meshopt_compression: ${mode} byteStride must be 2 or 4`);
    const view = stride === 2 ? new Uint16Array(out.buffer) : new Uint32Array(out.buffer);
    if (mode === 'TRIANGLES') meshoptDecodeIndexBuffer(view, count, src);
    else meshoptDecodeIndexSequence(view, count, src);
  } else {
    throw new Error(`EXT_meshopt_compression: unknown mode '${mode}'`);
  }
  if (filter && filter !== 'NONE') {
    if (mode !== 'ATTRIBUTES') throw new Error('EXT_meshopt_compression: filters only apply to ATTRIBUTES');
    if (filter === 'OCTAHEDRAL') {
      if (stride === 4) meshoptFilterOct(new Int8Array(out.buffer), count);
      else if (stride === 8) meshoptFilterOct(new Int16Array(out.buffer), count);
      else throw new Error('EXT_meshopt_compression: OCTAHEDRAL filter requires byteStride 4 or 8');
    } else if (filter === 'QUATERNION') {
      if (stride !== 8) throw new Error('EXT_meshopt_compression: QUATERNION filter requires byteStride 8');
      meshoptFilterQuat(new Int16Array(out.buffer), count);
    } else if (filter === 'EXPONENTIAL') {
      meshoptFilterExp(new Uint32Array(out.buffer), new Float32Array(out.buffer), (count * stride) >> 2);
    } else {
      throw new Error(`EXT_meshopt_compression: unknown filter '${filter}'`);
    }
  }
  return out;
}


/** Drop-in for three's `MeshoptDecoder` object, so glTF loaders written against that interface work unchanged. */
export const MeshoptDecoder = {
  supported: true,
  ready: Promise.resolve(),
  decodeGltfBuffer(target: Uint8Array, count: number, stride: number, source: Uint8Array, mode: string, filter?: string): void {
    const out = meshoptDecodeGltfBuffer(source, count, stride, mode, filter);
    if (target.byteLength < out.byteLength) throw new RangeError('EXT_meshopt_compression: target buffer is too small');
    target.set(out);
  },
};
