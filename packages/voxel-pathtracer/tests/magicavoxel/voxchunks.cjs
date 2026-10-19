// Read and rewrite the rOBJ / rCAM dictionaries of a .vox (MagicaVoxel's own saved render settings).
const fs = require('fs');
const str = (s) => { const b = Buffer.from(s, 'latin1'), o = Buffer.alloc(4 + b.length); o.writeInt32LE(b.length, 0); b.copy(o, 4); return o; };
const dictBuf = (d) => { const e = Object.entries(d), h = Buffer.alloc(4); h.writeInt32LE(e.length, 0); return Buffer.concat([h, ...e.flatMap(([k, v]) => [str(k), str(String(v))])]); };
const chunk = (id, content) => { const h = Buffer.alloc(12); h.write(id, 0, 'latin1'); h.writeInt32LE(content.length, 4); h.writeInt32LE(0, 8); return Buffer.concat([h, content]); };
function read(file) {
  const b = fs.readFileSync(file), chunks = []; let o = 20;
  const rd = (p) => { const n = b.readInt32LE(p); return [b.toString('latin1', p + 4, p + 4 + n), p + 4 + n]; };
  const dict = (p) => { const n = b.readInt32LE(p); p += 4; const d = {}; for (let i = 0; i < n; i++) { let k, v; [k, p] = rd(p); [v, p] = rd(p); d[k] = v; } return d; };
  while (o < b.length) { const id = b.toString('latin1', o, o + 4), n = b.readInt32LE(o + 4), c = b.readInt32LE(o + 8);
    const e = { id, raw: b.subarray(o, o + 12 + n + c) };
    if (id === 'rOBJ') e.dict = dict(o + 12); if (id === 'rCAM') { e.cam = b.readInt32LE(o + 12); e.dict = dict(o + 16); }
    if (id === 'MATL') { e.mat = b.readInt32LE(o + 12); e.dict = dict(o + 16); }
    chunks.push(e); o += 12 + n + c; }
  return { header: b.subarray(0, 20), chunks };
}
function write(file, { header, chunks }) {
  const body = Buffer.concat(chunks.map((e) => {
    if (e.id === 'rOBJ' && e.dict) return chunk('rOBJ', dictBuf(e.dict));
    if (e.id === 'rCAM' && e.dict) { const i = Buffer.alloc(4); i.writeInt32LE(e.cam, 0); return chunk('rCAM', Buffer.concat([i, dictBuf(e.dict)])); }
    if (e.id === 'MATL' && e.dict) { const i = Buffer.alloc(4); i.writeInt32LE(e.mat, 0); return chunk('MATL', Buffer.concat([i, dictBuf(e.dict)])); }
    return e.raw; }));
  const h = Buffer.from(header); h.writeInt32LE(body.length, 16); fs.writeFileSync(file, Buffer.concat([h, body]));
}
const robj = (v, type) => v.chunks.find((e) => e.id === 'rOBJ' && e.dict._type === type).dict;
module.exports = { read, write, robj };
