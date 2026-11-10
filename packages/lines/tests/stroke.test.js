import test from 'node:test';
import assert from 'node:assert/strict';
import { Stroke, strokeShader } from '../dist/stroke.js';
import { rig } from './gpu-rig.js';

const positions = [0, 0, 0, 1, 0, 0, 1, 3, 0];
test('stroke validates and owns widths and progress, preserving widths on same-count edits', () => {
  const source = [0, 0.5, 2];
  const line = new Stroke({ positions, widths: source, progress: 0.25 });
  source[1] = 10;
  const copy = line.widths;
  copy[1] = 10;
  assert.deepEqual([...line.widths], [0, 0.5, 2]);
  line.setPositions(positions);
  assert.deepEqual([...line.widths], [0, 0.5, 2]);
  line.setPositions(positions.slice(0, 6));
  assert.deepEqual([...line.widths], [1, 1]);
  for (const value of [-1, 2, NaN, Infinity])
    assert.throws(() => {
      line.progress = value;
    }, RangeError);
  for (const widths of [[1], [1, -1], [NaN, 1], [Infinity, 1]]) assert.throws(() => line.setWidths(widths), RangeError);
});

test('stroke composes widths, world distances, dashes and both depth steps without repeated uploads', () => {
  const { lines, frame, gpu } = rig();
  const line = lines.add(new Stroke({ positions, widths: [0, 1, 2], progress: 0.5, dashed: true, depthWrite: true }));
  const first = frame();
  assert.ok(first.some(row => row[0] === 'buffer' && row[2].usage === 136 && row[2].size >= 32), 'storage struct has 16-byte alignment even with three widths');
  assert.ok(first.some(row => row[0] === 'module' && row[2].code.includes('stroke.widths[ia]')), 'the live renderer applies per-point widths');
  assert.equal(line.totalDistance, 4);
  assert.deepEqual([line.points[3], line.points[7], line.points[11]], [0, 1, 4]);
  const extra = lines.resources.get(line).extra;
  assert.ok(extra);
  assert.match(
    strokeShader(
      'let rawA=halfWidth(ca);let rawB=halfWidth(cb);\n@fragment fn fragment(i:Out)->@location(0) vec4f{ return vec4f(1.0); }',
    ),
    /stroke.widths\[ia\]/,
  );
  assert.equal(lines.stats.drawCalls, 2);
  const version = line.version;
  frame();
  assert.equal(line.version, version);
  line.progress = 0.75;
  frame();
  assert.equal(line.version, version, 'progress does not reupload geometry');
  line.setPositions(positions.slice(0, 6));
  frame();
  line.setPositions(positions);
  frame();
  line.matrix[0] = 2;
  frame();
  assert.equal(line.totalDistance, 5);
  lines.remove(line);
  assert.equal(lines.resources.size, 0);
  assert.ok(gpu);
});

test('loop reveal includes the closing edge, and segment lists accumulate independent lengths', () => {
  const { lines, frame } = rig();
  const loop = lines.add(new Stroke({ positions, mode: 'loop' }));
  const pairs = lines.add(new Stroke({ positions: [0, 0, 0, 1, 0, 0, 10, 0, 0, 13, 0, 0], mode: 'segments' }));
  frame();
  assert.ok(Math.abs(loop.totalDistance - (4 + Math.sqrt(10))) < 1e-6);
  assert.equal(pairs.totalDistance, 4);
});
