// Scores every scene with a MagicaVoxel snapshot: tile boards by tile, the rest by pixel.
const fs = require('fs'),
  { measure } = require('./measure.cjs'),
  { diff } = require('./diff.cjs');
const rows = [];
for (const name of fs.readFileSync('scenes.txt', 'utf8').split(/\s+/).filter(Boolean)) {
  const board = { B: 'B', D: 'D', E: 'E', G: 'G', P: 'P' }[name[0]];
  const d = diff(name);
  let tiles = '';
  if (board) {
    const a = measure(`${name}-mv.png`, board),
      b = measure(`${name}-ours.png`, board);
    const m = a.map((t, k) => Math.max(...t.rgb.map((v, c) => Math.abs(v - b[k].rgb[c]))));
    tiles = `tiles within 3: ${m.filter((x) => x <= 3).length}/${m.length}, worst ${Math.max(...m).toFixed(0)}`;
  }
  rows.push(
    `${name.padEnd(13)} pixels within 3: ${String(d.within3).padStart(5)}%  within 6: ${String(d.within6).padStart(5)}%  mean ${d.mean.map((v) => v.toFixed(1)).join('/')}  ${tiles}`,
  );
}
console.log(rows.join('\n'));
