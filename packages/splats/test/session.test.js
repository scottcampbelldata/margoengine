import test from 'node:test';
import assert from 'node:assert/strict';
import { SplatEditSession } from '../dist/session.js';
import { parsePly } from '../dist/data.js';
import { Splats } from '../dist/index.js';

// 6 splats on the x axis at x = 0..5; red for 0-2, blue for 3-5; opacity 0.9 except splat 5 at 0.05.
const cloud = (sh) => ({
  positions: Float32Array.from({ length: 18 }, (_, i) => (i % 3 === 0 ? i / 3 : 0)),
  covariances: new Float32Array(36).map((_, i) => ([0, 3, 5].includes(i % 6) ? 0.01 : 0)),
  colors: Float32Array.from({ length: 24 }, (_, i) => {
    const s = Math.floor(i / 4),
      c = i % 4;
    return c === 3 ? (s === 5 ? 0.05 : 0.9) : s < 3 ? [1, 0, 0][c] : [0, 0, 1][c];
  }),
  ...(sh ? { sphericalHarmonics: new Float32Array(6 * sh * 3) } : {}),
});
// An orthographic view: pixel x = (x + 1) * 100 on 700 px, pixel y = 50 for y = 0.
const view = { viewProjection: [2 / 7, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, -5 / 7, 0, 0, 1], width: 700, height: 100 };
const sel = (s) => [...s.selection];

test('world-space tools: box, sphere, modes, invert, clear', () => {
  const s = new SplatEditSession(cloud());
  assert.deepEqual(sel(s.selectBox([0.5, -1, -1], [2.5, 1, 1])), [1, 2]);
  assert.deepEqual(sel(s.selectSphere([5, 0, 0], 1.1)), [4, 5]);
  assert.deepEqual(sel(s.selectBox([0, -1, -1], [1, 1, 1], 'add')), [0, 1, 4, 5]);
  assert.deepEqual(sel(s.selectSphere([0, 0, 0], 0.1, 'subtract')), [1, 4, 5]);
  assert.deepEqual(sel(s.invertSelection()), [0, 2, 3]);
  assert.equal(s.selectedCount, 3);
  assert.deepEqual(sel(s.clearSelection()), []);
  assert.equal(s.selectAll().selectedCount, 6);
  assert.throws(() => s.selectBox([0, 0], [1, 1, 1]), RangeError);
  assert.throws(() => s.selectSphere([0, 0, 0], 1, 'xor'), RangeError);
});

test('screen tools: brush, rect, lasso, and splats behind the camera are never hit', () => {
  const s = new SplatEditSession(cloud());
  assert.deepEqual(sel(s.selectBrush(view, 350, 50, 60)), [2, 3]);
  assert.deepEqual(sel(s.selectRect(view, 90, 0, 310, 100)), [0, 1, 2]);
  assert.deepEqual(sel(s.selectRect(view, 310, 100, 90, 0)), [0, 1, 2], 'corners in any order');
  const poly = [[150, 0], [450, 0], [450, 100], [150, 100]];
  assert.deepEqual(sel(s.selectLasso(view, poly)), [1, 2, 3]);
  const triangle = [[0, 0], [700, 0], [0, 100]];
  assert.deepEqual(sel(s.selectLasso(view, triangle)), [0, 1, 2], 'at y = 50 the diagonal passes x = 350');
  const behind = { ...view, viewProjection: [...view.viewProjection.slice(0, 15), -1] }; // clip w -1: all behind
  assert.deepEqual(sel(s.selectRect(behind, -1e6, -1e6, 1e6, 1e6)), []);
});

test('selection by colour and by opacity', () => {
  const s = new SplatEditSession(cloud());
  assert.deepEqual(sel(s.selectByColor([1, 0, 0], 0.1)), [0, 1, 2]);
  assert.deepEqual(sel(s.selectByColor([0, 0, 1], 0.1)), [3, 4, 5]);
  assert.deepEqual(sel(s.selectByOpacity(0, 0.1)), [5]);
  assert.deepEqual(sel(s.selectByOpacity(0.5, 1)), [0, 1, 2, 3, 4]);
});

test('hide, delete, unhide, undo and redo restore exactly what they changed', () => {
  const s = new SplatEditSession(cloud());
  s.selectBox([0, -1, -1], [1, 1, 1]).hideSelected();
  assert.equal(s.visibleCount, 4);
  assert.deepEqual(sel(s.selectAll()), [2, 3, 4, 5], 'hidden splats cannot be selected');
  s.selectByOpacity(0, 0.1).deleteSelected();
  assert.equal(s.toData().positions.length / 3, 3);
  assert.equal(s.unhideAll().visibleCount, 5, 'the deleted one stays gone');
  assert.ok(s.undo());
  assert.equal(s.visibleCount, 3);
  assert.ok(s.undo()); // the delete
  assert.equal(s.visibleCount, 4);
  assert.ok(s.redo());
  assert.equal(s.visibleCount, 3);
  while (s.undo());
  assert.equal(s.visibleCount, 6);
  assert.equal(s.selectedCount, 0);
  assert.equal(s.canUndo, false);
  assert.ok(s.canRedo);
  s.selectAll();
  assert.equal(s.canRedo, false, 'a new edit drops the redo steps');
  s.deleteSelected();
  assert.throws(() => s.toData(), RangeError, 'nothing left');
});

test('transformSelected moves only the selection, about a pivot, with undo', () => {
  const s = new SplatEditSession(cloud(4));
  s.selectBox([-1, -1, -1], [0.5, 1, 1]).transformSelected([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 3, 0, 1]);
  let d = s.toData();
  assert.deepEqual([...d.positions.slice(0, 6)], [0, 3, 0, 1, 0, 0]);
  // Scale by 2 about (2, 0, 0): splat at x = 3 goes to x = 4.
  s.selectBox([2.5, -1, -1], [3.5, 1, 1]).transformSelected([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1], { about: [2, 0, 0] });
  d = s.toData();
  assert.ok(Math.abs(d.positions[9] - 4) < 1e-6);
  assert.ok(Math.abs(d.covariances[18] - 0.04) < 1e-6, 'scaling by 2 multiplies the covariance by 4');
  assert.equal(d.sphericalHarmonics.length, 6 * 4 * 3);
  s.undo();
  assert.equal(s.toData().positions[9], 3);
  assert.throws(() => s.transformSelected([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]), RangeError, 'singular');
});

test('adjustColor changes the selection only, keeps RGB in range, and edits the SH base band', () => {
  const s = new SplatEditSession(cloud());
  s.selectByColor([1, 0, 0], 0.1).adjustColor({ hue: 120, opacity: 0.5 });
  let c = s.toData().colors;
  assert.ok(Math.abs(c[1] - 1) < 1e-6 && Math.abs(c[0]) < 1e-6, 'red turned 120 degrees is green');
  assert.ok(Math.abs(c[3] - 0.45) < 1e-6);
  assert.deepEqual([...c.slice(12, 16)], [...Float32Array.of(0, 0, 1, 0.9)], 'unselected splats keep their colour');
  s.selectAll().adjustColor({ saturation: 0 });
  c = s.toData().colors;
  assert.ok(Math.abs(c[0] - c[1]) < 1e-6 && Math.abs(c[1] - c[2]) < 1e-6, 'grey');
  const withSh = new SplatEditSession(cloud(4));
  withSh.selectAll().adjustColor({ brightness: 0 });
  assert.ok(withSh.toData().sphericalHarmonics.slice(0, 3).every((v) => Math.abs(v + 0.5 / 0.2820947918) < 1e-4));
  assert.throws(() => s.adjustColor({ saturation: -1 }), RangeError);
});

test('export writes the edited set as PLY and splat, and applyTo shows hidden splats at opacity 0', async () => {
  const s = new SplatEditSession(cloud());
  s.selectByOpacity(0, 0.1).deleteSelected();
  const back = parsePly(await s.encode('ply'));
  assert.equal(back.positions.length / 3, 5);
  assert.deepEqual([...back.positions.slice(0, 3)], [0, 0, 0]);
  assert.equal((await s.encode('splat')).length, 5 * 32);
  await assert.rejects(s.encode('obj'), RangeError);
  const pool = Splats.reserve(6);
  s.applyTo(pool);
  const alpha = Array.from((await pool.read()).colors).filter((_, i) => i % 4 === 3);
  assert.deepEqual(alpha.map((a) => Math.round(a * 100) / 100), [0.9, 0.9, 0.9, 0.9, 0.9, 0]);
  assert.throws(() => s.applyTo(Splats.reserve(3)), RangeError);
});
