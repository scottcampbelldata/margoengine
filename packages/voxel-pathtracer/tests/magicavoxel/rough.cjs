// Metal roughness: X-rough reflection profiles and the D-sky-lin metal row, MagicaVoxel vs each candidate.
const { decode, measure } = require('./measure.cjs');
const tags = process.argv.slice(2);
const cols = [43, 166, 288, 418, 540, 670, 792, 922], rough = [0, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 1];
const prof = (img, cx) => { const p = []; for (let y = 384; y < 420; y += 4) { let s = 0; for (let x = cx - 25; x < cx + 25; x++) s += img.data[4 * (y * 960 + x)]; p.push(Math.round(s / 50)); } return p; };
const mv = decode('X-rough-mv.png'), cand = tags.map((t) => decode(`X-rough-ours${t ? '-' + t : ''}.png`));
const err = tags.map(() => 0);
for (let k = 1; k < 8; k++) {
  const m = prof(mv, cols[k]); console.log('r' + rough[k], 'mv', m.join(' '));
  cand.forEach((c, i) => { const p = prof(c, cols[k]); err[i] += p.reduce((s, v, j) => s + Math.abs(v - m[j]), 0) / p.length; console.log('   ', tags[i] || 'cur', p.join(' ')); });
}
console.log('mean profile error', tags.map((t, i) => `${t || 'cur'} ${(err[i] / 7).toFixed(1)}`).join('  '));
const dm = measure('D-sky-lin-mv.png', 'D').filter((t) => t.j === 3);
const dc = tags.map((t) => measure(`D-sky-lin-ours${t ? '-' + t : ''}.png`, 'D').filter((x) => x.j === 3));
console.log('sky row mv', dm.map((t) => t.rgb[0].toFixed(0)).join(' '));
dc.forEach((d, i) => console.log('sky row', tags[i] || 'cur', d.map((t) => t.rgb[0].toFixed(0)).join(' ')));
