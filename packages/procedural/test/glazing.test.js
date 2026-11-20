import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWindowPane } from '../dist/index.js';

// KB-CABIN-EDGE-SOFT2: Cabin Hearth's lantern threw a crisp, window-shaped patch on the snow, cut by the mullion's and
// cross bar's shadows, through a window with no glass. Frosted glazing is a diffuser: as a shadow caster it must stop
// every straight ray from the lamp through the opening, so the beam, and the bars' shadow lines in it, never reach the
// snow; its light leaves diffusely instead (clustered/area openingLight).

/** Möller and Trumbore ray-triangle test: the nearest hit distance along `d` from `o`, or Infinity. */
function hit(o, d, geometry, offset) {
  const p = geometry.positions,
    ix = geometry.indices;
  let best = Infinity;
  for (let t = 0; t < ix.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => [0, 1, 2].map((j) => p[ix[t + k] * 3 + j] + offset[j])),
      e1 = b.map((v, j) => v - a[j]),
      e2 = c.map((v, j) => v - a[j]),
      q = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]],
      det = e1[0] * q[0] + e1[1] * q[1] + e1[2] * q[2];
    if (Math.abs(det) < 1e-12) continue;
    const s = o.map((v, j) => v - a[j]),
      u = (s[0] * q[0] + s[1] * q[1] + s[2] * q[2]) / det,
      r = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]],
      v = (d[0] * r[0] + d[1] * r[1] + d[2] * r[2]) / det,
      dist = (e2[0] * r[0] + e2[1] * r[1] + e2[2] * r[2]) / det;
    if (u >= -1e-9 && v >= -1e-9 && u + v <= 1 + 1e-9 && dist > 0) best = Math.min(best, dist);
  }
  return best;
}

test('a frosted pane stops every ray from the lantern through the window, so its beam draws no bar lines outside', () => {
  // Cabin Hearth: the window 1.2 x 1.1 m centred on [1.2, 1.5] in the front wall's middle plane z 2.5, the lantern at
  // [1.2, 1.875, 1.95] (examples/cabin-hearth/main.ts).
  const lantern = [1.2, 1.875, 1.95],
    centre = [1.2, 1.5, 2.5],
    rays = [];
  for (let i = 0; i <= 24; i++)
    for (let j = 0; j <= 22; j++) {
      // Points just inside the opening's outer edge, 0.15 m out.
      const target = [centre[0] - 0.6 + (1.2 * i) / 24, centre[1] - 0.55 + (1.1 * j) / 22, 2.65],
        d = target.map((v, k) => v - lantern[k]),
        l = Math.hypot(...d);
      rays.push([d.map((v) => v / l), l]);
    }
  const frosted = generateWindowPane({ width: 1.2, height: 1.1, glazing: 'frosted' }),
    clear = generateWindowPane({ width: 1.2, height: 1.1 });
  assert.equal(frosted.frostedShare, 1);
  assert.equal(frosted.clear.indices.length, 0, 'frosted over: no clear glass is left');
  for (const [d, l] of rays) assert.ok(hit(lantern, d, frosted.frosted, centre) < l, `ray ${d.map((v) => v.toFixed(3))} is stopped`);
  // Clear glass (the default) is no frost: nothing frosted to stop the beam, the whole pane clear.
  assert.equal(clear.frostedShare, 0);
  assert.equal(clear.frosted.indices.length, 0);
  for (const [d, l] of rays) assert.ok(hit(lantern, d, clear.clear, centre) < l, 'the clear pane fills the opening');
});

test('frost grows in from the edges: a border frost x min(w, h) / 2 wide, the middle clear', () => {
  const w = 1.2,
    h = 0.8;
  for (const frost of [0, 0.25, 0.5, 0.9, 1]) {
    const pane = generateWindowPane({ width: w, height: h, glazing: 'frosted', frost }),
      t = (frost * Math.min(w, h)) / 2,
      share = 1 - ((w - 2 * t) * (h - 2 * t)) / (w * h);
    assert.ok(Math.abs(pane.frostedShare - share) < 1e-12, `frost ${frost}: ${pane.frostedShare} against ${share}`);
    // The outdoor faces of both parts tile the pane: their areas sum to w x h, the frosted ones to the share.
    const area = (g, z) => {
      let sum = 0;
      for (let i = 0; i < g.indices.length; i += 3) {
        const [a, b, c] = [0, 1, 2].map((k) => [0, 1, 2].map((j) => g.positions[g.indices[i + k] * 3 + j]));
        if (![a, b, c].every((p) => Math.abs(p[2] - z) < 1e-6) || g.normals[g.indices[i] * 3 + 2] < 0.5) continue;
        sum += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
      }
      return sum;
    };
    assert.ok(Math.abs(area(pane.frosted, 0.002) - share * w * h) < 1e-6);
    assert.ok(Math.abs(area(pane.frosted, 0.002) + area(pane.clear, 0.002) - w * h) < 1e-6);
    // Points near the edge are frosted before points in the middle.
    if (frost > 0 && frost < 1) {
      const ray = (x, y) => hit([x, y, -1], [0, 0, 1], pane.frosted, [0, 0, 0]) < Infinity;
      assert.ok(ray(-w / 2 + t / 2, 0) && ray(0, h / 2 - t / 2), 'the edges are frosted');
      assert.ok(!ray(0, 0), 'the middle is clear');
    }
  }
  // Group 0 is the outdoor face (+Z normals), group 1 the room face and the edges.
  const pane = generateWindowPane({ width: 1, height: 1, glazing: 'frosted', frost: 0.5 }),
    [outdoor, rest] = pane.frosted.groups;
  assert.deepEqual([outdoor.start, outdoor.materialIndex, rest.start, rest.materialIndex], [0, 0, outdoor.count, 1]);
  assert.equal(outdoor.count + rest.count, pane.frosted.indices.length);
  for (let i = 0; i < outdoor.count; i++) assert.equal(pane.frosted.normals[pane.frosted.indices[i] * 3 + 2], 1);
  for (let i = outdoor.count; i < pane.frosted.indices.length; i++) assert.ok(pane.frosted.normals[pane.frosted.indices[i] * 3 + 2] < 0.5);
});

// KB-CABIN-FROST2: the frosted window lost its cross bars: the scene's bars stood behind a pane that covered them, and
// the pane had none of its own. The bars now sit in the glass's plane, between the lites, and the glass stops at them.
test('glazing bars divide the pane into lites, in the glass plane, and the glass stops at them', () => {
  const w = 1.2,
    h = 1.1,
    bar = 0.045,
    depth = 0.05,
    pane = generateWindowPane({ width: w, height: h, glazing: 'frosted', lites: [2, 2], barWidth: bar, barDepth: depth }),
    ray = (x, y, g) => hit([x, y, -1], [0, 0, 1], g, [0, 0, 0]);
  assert.ok(pane.bars.indices.length > 0, 'the bars are built');
  // Through the cross and along each bar, the first thing a ray from the room meets is a bar, at its room-side face.
  for (const [x, y] of [[0, 0], [0, 0.4], [0, -0.4], [0.4, 0], [-0.4, 0], [0.02, 0.5], [-0.5, -0.02]]) {
    assert.ok(Math.abs(ray(x, y, pane.bars) - (1 - depth / 2)) < 1e-6, `a bar at [${x}, ${y}]`);
    assert.equal(ray(x, y, pane.frosted), Infinity, `no glass under the bar at [${x}, ${y}]`);
  }
  // Through each lite: glass, frosted over, and no bar.
  for (const [x, y] of [[0.3, 0.3], [-0.3, 0.3], [0.3, -0.3], [-0.3, -0.3], [0.03, 0.03], [-0.59, 0.54]]) {
    assert.equal(ray(x, y, pane.bars), Infinity, `no bar at [${x}, ${y}]`);
    assert.ok(Math.abs(ray(x, y, pane.frosted) - (1 - 0.002)) < 1e-6, `glass at [${x}, ${y}]`);
  }
  // Areas: the glass's outdoor faces are the four lites; the bars' are the cross, with no overlap at the crossing.
  const area = (g, z) => {
    let sum = 0;
    for (let i = 0; i < g.indices.length; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => [0, 1, 2].map((j) => g.positions[g.indices[i + k] * 3 + j]));
      if (![a, b, c].every((p) => Math.abs(p[2] - z) < 1e-6)) continue;
      sum += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
    }
    return sum;
  };
  assert.ok(Math.abs(area(pane.frosted, 0.002) - (w - bar) * (h - bar)) < 1e-6);
  assert.ok(Math.abs(area(pane.bars, depth / 2) - (w * h - (w - bar) * (h - bar))) < 1e-6);
  assert.equal(pane.frostedShare, 1);
  // The frosted glass's UVs are the pane's: u from the left edge, v down from the top, so a map lies on it as on the pane.
  const { positions, uvs } = pane.frosted;
  for (let v = 0; v < positions.length / 3; v++) {
    assert.ok(Math.abs(uvs[v * 2] - (positions[v * 3] + w / 2) / w) < 1e-6);
    assert.ok(Math.abs(uvs[v * 2 + 1] - (h / 2 - positions[v * 3 + 1]) / h) < 1e-6);
  }
  // Frost grows in from each lite's edges, the bars' included.
  const part = generateWindowPane({ width: w, height: h, glazing: 'frosted', frost: 0.5, lites: [2, 2], barWidth: bar }),
    lite = (w - bar) / 2,
    liteH = (h - bar) / 2,
    t = (0.5 * Math.min(lite, liteH)) / 2;
  assert.ok(Math.abs(part.frostedShare - (1 - ((lite - 2 * t) * (liteH - 2 * t)) / (lite * liteH))) < 1e-12);
  assert.ok(ray(bar / 2 + t / 2, 0.3, part.frosted) < Infinity && ray(bar / 2 + lite / 2, 0.3, part.frosted) === Infinity);
  // One lite has no bars.
  assert.equal(generateWindowPane({ width: w, height: h }).bars.indices.length, 0);
});

test('generateWindowPane rejects what it cannot build', () => {
  for (const bad of [
    {},
    { width: 0, height: 1 },
    { width: 1, height: Number.NaN },
    { width: 21, height: 1 },
    { width: 1, height: 1, thickness: 0 },
    { width: 1, height: 1, glazing: 'stained' },
    { width: 1, height: 1, glazing: 'frosted', frost: 1.1 },
    { width: 1, height: 1, glazing: 'frosted', frost: -0.1 },
    { width: 1, height: 1, lites: [0, 1] },
    { width: 1, height: 1, lites: [17, 1] },
    { width: 1, height: 1, lites: [2.5, 1] },
    { width: 1, height: 1, lites: [2] },
    { width: 1, height: 1, lites: [2, 2], barWidth: 0.5 },
    { width: 1, height: 1, barWidth: 0 },
    { width: 1, height: 1, barDepth: 0.003 },
    { width: 1, height: 1, barDepth: 0.4 },
  ])
    assert.throws(() => generateWindowPane(bad), RangeError, JSON.stringify(bad));
  assert.throws(() => generateWindowPane(), RangeError);
});
