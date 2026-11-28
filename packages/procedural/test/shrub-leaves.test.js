// KB-SHRUB-BLOBS1: the shrub was three closed smooth domes, which draw as flat blobs. It is separate leaves with sky
// between them, and its coarser levels keep the full level's cover (Cook, Halstead, Planck and Ryu 2007, Stochastic
// simplification of aggregate detail).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateShrubMesh,
  generateShrubStemsMesh,
  generateTundraShrubMesh,
  generateTundraShrubStemsMesh,
} from '../dist/index.js';

const SIZE = 160;
/** The side view of a mesh on a grid: which cells a triangle covers. */
function silhouette({ positions, indices }) {
  const cells = new Uint8Array(SIZE * SIZE),
    at = (i) => [((positions[i * 3] + 0.8) / 1.6) * SIZE, ((positions[i * 3 + 1] + 0.1) / 1.6) * SIZE];
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => at(indices[t + k])),
      side = (p, q, x, y) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
    for (let y = Math.floor(Math.min(a[1], b[1], c[1])); y <= Math.max(a[1], b[1], c[1]); y++)
      for (let x = Math.floor(Math.min(a[0], b[0], c[0])); x <= Math.max(a[0], b[0], c[0]); x++) {
        const s = [side(a, b, x + 0.5, y + 0.5), side(b, c, x + 0.5, y + 0.5), side(c, a, x + 0.5, y + 0.5)];
        if (s.every((v) => v >= 0) || s.every((v) => v <= 0)) cells[y * SIZE + x] = 1;
      }
  }
  return cells;
}
/** Covered cells, and how ragged their edge is: edge cells squared over 4 pi covered cells, about 1 for a disc. */
function measure(cells) {
  let area = 0,
    edge = 0;
  for (let i = 0; i < cells.length; i++)
    if (cells[i]) {
      area++;
      if (!cells[i - 1] || !cells[i + 1] || !cells[i - SIZE] || !cells[i + SIZE]) edge++;
    }
  return { area, ragged: (edge * edge) / (4 * Math.PI * area) };
}

test('a shrub draws separate leaves with a ragged outline, the same cover at every detail level', () => {
  const levels = [2, 1, 0].map((detail) => measure(silhouette(generateShrubMesh({ detail }))));
  // The three domes measured 1.3 to 2; leaves break the outline and open gaps.
  assert.ok(levels[0].ragged > 5, `full detail raggedness ${levels[0].ragged}`);
  for (const { ragged } of levels) assert.ok(ragged > 3, `raggedness ${ragged}`);
  for (const level of levels.slice(1))
    assert.ok(Math.abs(level.area / levels[0].area - 1) < 0.25, `cover ${level.area} against ${levels[0].area}`);
  // Dense enough to read as one shrub: over a quarter of its box.
  assert.ok(levels[0].area > 0.25 * (SIZE / 1.6) ** 2 * 1.36 * 0.89, `cover ${levels[0].area}`);
});

// KB-SHRUB-TUNDRA1: the tundra shrub was six closed smooth domes, and neither shrub had any wood.
test('a tundra shrub is a low mat of separate leaves with a ragged outline', () => {
  for (const detail of [2, 1, 0]) {
    const mesh = generateTundraShrubMesh({ detail }),
      { ragged } = measure(silhouette(mesh));
    // The domes measured about 1.5.
    assert.ok(ragged > 3, `detail ${detail} raggedness ${ragged}`);
    // Separate leaves of 12 corners (two faces of six), not a welded surface.
    assert.equal((mesh.positions.length / 3) % 12, 0, `detail ${detail}`);
    assert.equal(mesh.indices.length / 3, ((mesh.positions.length / 3 / 12) * 8) | 0, `detail ${detail}`);
  }
});

test('each shrub has stems from its foot into its leaves, within the leaves box', () => {
  for (const [stems, leaves] of [
    [generateShrubStemsMesh, generateShrubMesh],
    [generateTundraShrubStemsMesh, generateTundraShrubMesh],
  ])
    for (const detail of [2, 1, 0]) {
      const wood = stems({ detail }).positions,
        crown = leaves({ detail }).positions;
      for (let axis = 0; axis < 3; axis++) {
        const of = (data) => Array.from(data).filter((_, i) => i % 3 === axis);
        assert.ok(Math.min(...of(wood)) >= Math.min(...of(crown)) - 0.04, `${stems.name} ${detail} low ${axis}`);
        assert.ok(Math.max(...of(wood)) <= Math.max(...of(crown)), `${stems.name} ${detail} high ${axis}`);
      }
      // Every stem starts in the ground: two lengths of six corners each, the first ring at the foot.
      assert.equal((wood.length / 3) % 12, 0);
      for (let at = 0; at < wood.length; at += 36) assert.ok(wood[at + 1] < 0.02, `${stems.name} foot ${wood[at + 1]}`);
    }
});
