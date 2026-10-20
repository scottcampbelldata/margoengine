// Prints a .vox file's MATL (distinct), rOBJ and rCAM chunks.
const fs = require('fs');
const b = fs.readFileSync(process.argv[2]);
let o = 20;
const rd = (p) => {
  const n = b.readInt32LE(p);
  return [b.toString('latin1', p + 4, p + 4 + n), p + 4 + n];
};
const dict = (p) => {
  const n = b.readInt32LE(p);
  p += 4;
  const d = {};
  for (let i = 0; i < n; i++) {
    let k, v;
    [k, p] = rd(p);
    [v, p] = rd(p);
    d[k] = v;
  }
  return d;
};
const seen = new Set(),
  only = process.argv[3];
while (o < b.length) {
  const id = b.toString('latin1', o, o + 4),
    n = b.readInt32LE(o + 4);
  if (id === 'rOBJ' && (!only || only === 'r')) console.log('rOBJ', JSON.stringify(dict(o + 12)));
  else if (id === 'rCAM' && b.readInt32LE(o + 12) === 0) console.log('rCAM 0', JSON.stringify(dict(o + 16)));
  else if (id === 'MATL' && (!only || only === 'm')) {
    const k = JSON.stringify(dict(o + 16));
    if (!seen.has(k)) {
      seen.add(k);
      console.log('MATL', b.readInt32LE(o + 12), k);
    }
  }
  o += 12 + n;
}
