import test from 'node:test';
import assert from 'node:assert/strict';
import { clipmapGrid } from '../dist/index.js';
import { readFileSync } from 'node:fs';

const terrainVertex = readFileSync(new URL('../src/shader.ts', import.meta.url), 'utf8');

// KB-TERRAIN-CRESTTEETH1: every cell used to be two triangles split along one fixed diagonal, so a crest running along
// the other diagonal was drawn as a row of teeth. Each cell is now a fan of four triangles around a centre vertex that
// the vertex shader moves onto the diagonal that follows the ground (teeth.browser.mjs draws it on the GPU).
test('each clipmap cell is a fan of four counter-clockwise triangles around its own centre vertex', () => {
  const resolution = 16,
    side = resolution + 1,
    corners = side * side,
    { vertices, center, ring } = clipmapGrid(resolution);
  assert.equal(vertices.length, (corners + resolution * resolution) * 2);
  assert.equal(center.length, resolution * resolution * 12);
  assert.equal(ring.length, resolution * resolution * 9);
  const at = (v) => [vertices[v * 2], vertices[v * 2 + 1]];
  for (let cell = 0; cell < resolution * resolution; cell++) {
    const fan = center.subarray(cell * 12, cell * 12 + 12),
      e = corners + cell,
      [ex, ez] = at(e);
    assert.ok(Math.abs(ex % 1) === 0.5 && Math.abs(ez % 1) === 0.5, 'centres sit at half-unit offsets');
    let area = 0;
    for (let t = 0; t < 12; t += 3) {
      assert.equal(fan[t + 2], e, 'every triangle of the cell meets at its centre');
      const [ax, az] = at(fan[t]),
        [bx, bz] = at(fan[t + 1]);
      for (const [x, z] of [
        [ax, az],
        [bx, bz],
      ])
        assert.ok(Math.abs(x - ex) === 0.5 && Math.abs(z - ez) === 0.5, 'the other two are corners of the same cell');
      // Signed area in XZ: the cell's old triangles (a, c, b) and (b, c, d) were negative here, as these are.
      const signed = ((bx - ax) * (ez - az) - (bz - az) * (ex - ax)) / 2;
      assert.ok(signed < 0, 'same winding as the two-triangle cell');
      area -= signed;
    }
    assert.equal(area, 1, 'the four triangles cover the cell once');
  }
});

test('the vertex shader puts each centre on the diagonal nearer the cubic height at the cell centre', () => {
  assert.match(terrainVertex, /let along=abs\(r-ad\)<abs\(r-bc\);/);
  assert.match(terrainVertex, /m=select\(\(b\+c\)\*0\.5,\(a\+d\)\*0\.5,along\);lift=select\(bc,ad,along\);/);
  assert.match(terrainVertex, /select\(height\(xz\),lift,centre\)/);
});
