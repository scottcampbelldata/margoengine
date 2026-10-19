// node cmp.cjs <name> <board>: tile-by-tile MagicaVoxel vs ours (8-bit), worst differences first.
const { measure } = require('./measure.cjs');
const [name, board] = process.argv.slice(2);
const mv = measure(`${name}-mv.png`, board), ours = measure(`${name}-ours.png`, board);
const rows = mv.map((t, k) => ({ t, o: ours[k].rgb, d: Math.max(...t.rgb.map((v, c) => Math.abs(v - ours[k].rgb[c]))) }));
const all = rows.map((r) => r.d), mean = all.reduce((a, b) => a + b, 0) / all.length;
console.log(`${name}: tiles ${rows.length}, mean max-channel diff ${mean.toFixed(2)}, within 3: ${all.filter((d) => d <= 3).length}, within 6: ${all.filter((d) => d <= 6).length}`);
for (const r of rows.sort((a, b) => b.d - a.d).slice(0, Number(process.argv[4] ?? 12)))
  console.log(r.t.i, r.t.j, JSON.stringify(r.t.color), JSON.stringify(r.t.mat).slice(0, 80), 'mv', r.t.rgb.map(Math.round).join(' '), 'ours', r.o.map(Math.round).join(' '), 'd', r.d.toFixed(1));
