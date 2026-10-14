import {readResponse} from '../../shared/loading.js';
/** One FBX record: binary and ASCII files share this shape. Array payloads (`*N { a: ... }` in ASCII) are props[0] as a typed array. */
export interface FBXNode {name: string; props: any[]; nodes: FBXNode[]}
const MAGIC = 'Kaydara FBX Binary  \0', maxDecoded = 256 * 1024 * 1024;
function fail(message: string): never {throw new RangeError('FBX: ' + message);}
/** Binary strings store `Name\0\x01Class`; ASCII stores `Class::Name`. Both become `Class::Name`. */
const text = (s: string) => {const i = s.indexOf('\0\x01'); return i < 0 ? s : s.slice(i + 2) + '::' + s.slice(0, i);};
const int64 = (v: bigint) => v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v;
async function inflate(data: Uint8Array, size: number): Promise<Uint8Array> {
  const out = await readResponse(new Response(new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)), {maxBytes: size, label: 'FBX array'});
  if (out.length !== size) fail('compressed array has the wrong length'); return out;
}
function binary(bytes: Uint8Array): Promise<FBXNode[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), version = view.getUint32(23, true), wide = version >= 7500, head = wide ? 25 : 13;
  if (version < 7000) fail('version ' + version + ' is not supported');
  const pending: Promise<void>[] = [], decoder = new TextDecoder(); let decoded = 0;
  const u = (p: number) => wide ? Number(view.getBigUint64(p, true)) : view.getUint32(p, true);
  const need = (p: number, n: number) => {if (n < 0 || p + n > bytes.length) fail('truncated record'); return p + n;};
  function array(code: string, p: number, props: any[]): number {
    need(p, 12); const count = view.getUint32(p, true), encoding = view.getUint32(p + 4, true), length = view.getUint32(p + 8, true), end = need(p + 12, length);
    const width = code === 'd' || code === 'l' ? 8 : code === 'b' ? 1 : 4, size = count * width, raw = bytes.subarray(p + 12, end), index = props.length;
    if ((decoded += size) > maxDecoded) fail('decoded arrays exceed 256 MiB');
    const typed = (data: Uint8Array) => {
      const buffer = data.slice().buffer;
      props[index] = code === 'f' ? new Float32Array(buffer) : code === 'd' ? new Float64Array(buffer) : code === 'i' ? new Int32Array(buffer) : code === 'b' ? new Uint8Array(buffer) : Float64Array.from(new BigInt64Array(buffer), Number);
    };
    props.push(undefined);
    if (encoding === 0) {if (length !== size) fail('array length mismatch'); typed(raw);}
    else if (encoding === 1) pending.push(inflate(raw, size).then(typed));
    else fail('unknown array encoding ' + encoding);
    return end;
  }
  function record(p: number, depth: number): [FBXNode | null, number] {
    need(p, head); const end = u(p);
    if (!end) return [null, p + head];
    if (depth > 32) fail('records nest too deeply');
    const count = u(p + (wide ? 8 : 4)), nameLength = bytes[p + head - 1], props: any[] = [], nodes: FBXNode[] = [];
    if (end <= p || end > bytes.length) fail('record end outside file');
    const name = decoder.decode(bytes.subarray(p + head, need(p + head, nameLength)));
    let q = p + head + nameLength;
    for (let i = 0; i < count; i++) {
      const code = String.fromCharCode(bytes[q]); need(q, 1); q++;
      if (code === 'Y') {props.push(view.getInt16(q, true)); q = need(q, 2);}
      else if (code === 'C') {props.push(bytes[q] & 1); q = need(q, 1);}
      else if (code === 'I') {need(q, 4); props.push(view.getInt32(q, true)); q += 4;}
      else if (code === 'F') {need(q, 4); props.push(view.getFloat32(q, true)); q += 4;}
      else if (code === 'D') {need(q, 8); props.push(view.getFloat64(q, true)); q += 8;}
      else if (code === 'L') {need(q, 8); props.push(int64(view.getBigInt64(q, true))); q += 8;}
      else if (code === 'S' || code === 'R') {need(q, 4); const n = view.getUint32(q, true), data = bytes.subarray(q + 4, need(q + 4, n)); props.push(code === 'S' ? text(decoder.decode(data)) : data); q += 4 + n;}
      else if ('fdlib'.includes(code)) q = array(code, q, props);
      else fail('unknown property type ' + code);
    }
    while (q < end) {const [child, next] = record(q, depth + 1); q = next; if (!child) break; nodes.push(child);}
    return [{name, props, nodes}, end];
  }
  const nodes: FBXNode[] = [];
  for (let p = 27; p + head <= bytes.length;) {const [node, next] = record(p, 0); if (!node) break; nodes.push(node); p = next;}
  return Promise.all(pending).then(() => nodes);
}
function ascii(source: string): FBXNode[] {
  const version = /FBXVersion: *(\d+)/.exec(source); if (!version) fail('cannot find the version number');
  if (+version[1] < 7000) fail('version ' + version[1] + ' is not supported');
  const token = /\s+|;[^\n]*|"[^"]*"|\*\d+|[A-Za-z_][\w|]*:|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[A-Za-z_][\w|]*|[{},]/y;
  let at = 0, peeked: string | undefined;
  const peek = () => {
    while (peeked === undefined && at < source.length) {
      token.lastIndex = at; const m = token.exec(source); if (!m) fail('invalid character at offset ' + at);
      at = token.lastIndex; if (!/^[\s;]/.test(m[0])) peeked = m[0];
    }
    return peeked ?? '';
  };
  const take = () => {const t = peek(); peeked = undefined; return t;};
  function nodes(depth: number): FBXNode[] {
    if (depth > 32) fail('records nest too deeply');
    const out: FBXNode[] = [];
    for (let t = peek(); t && t !== '}'; t = peek()) {
      if (!t.endsWith(':') || t[0] === '"') fail('expected a record name, found ' + t.slice(0, 20));
      take(); const node: FBXNode = {name: t.slice(0, -1), props: [], nodes: []}; out.push(node);
      if (node.name === 'a' && depth) {
        const close = source.indexOf('}', at); if (close < 0) fail('unterminated array');
        const body = source.slice(at, close).trim(), values = body ? body.split(',').map(Number) : [];
        if (values.some(v => !Number.isFinite(v))) fail('invalid array value');
        node.props = [Float64Array.from(values)]; at = close; return [node];
      }
      for (let v = peek(); v && v !== '}' && !(v.endsWith(':') && v[0] !== '"'); v = peek()) {
        take();
        if (v === '{') {const children = nodes(depth + 1); if (take() !== '}') fail('unterminated record'); const a = children.length === 1 && children[0].name === 'a' ? children[0] : undefined; if (a) node.props = [a.props[0]]; else node.nodes = children; break;}
        if (v[0] === '"') node.props.push(text(v.slice(1, -1)));
        else if (/^[-+.\d]/.test(v)) {const n = Number(v); node.props.push(Number.isSafeInteger(n) || !/^[-+]?\d+$/.test(v) ? n : int64(BigInt(v)));}
        else if (v !== ',' && v[0] !== '*') node.props.push(v);
      }
    }
    return out;
  }
  const out = nodes(0); if (peek()) fail('unexpected }'); return out;
}
/** Reads binary (7.x, zlib arrays) or ASCII FBX into a record tree. */
export async function readFBX(bytes: Uint8Array): Promise<FBXNode[]> {
  if (bytes.length >= 27 && new TextDecoder().decode(bytes.subarray(0, 21)) === MAGIC) return binary(bytes);
  return ascii(new TextDecoder().decode(bytes));
}
