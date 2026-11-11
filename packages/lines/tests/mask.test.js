import test from 'node:test';
import assert from 'node:assert/strict';
import { Line } from '../dist/index.js';
import { linePickShader } from '../dist/pick.js';
import { rig } from './gpu-rig.js';

const strip = [0, 0, 0, 1, 0, 0, 2, 1, 0, 3, 0, 0];

test('a line mask keeps one bit a point of capacity; points added later start selected', () => {
  const line = new Line({ positions: strip, dashed: true, width: 6 });
  assert.equal(line.isSelected(0), true);
  const capacity = line.capacityVersion;
  line.setMask([1, 0, 1, 1], { mode: 'filter' });
  assert.equal(line.capacityVersion, capacity + 1, 'adding a mask reallocates');
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => line.isSelected(i)),
    [true, false, true, true],
  );
  assert.deepEqual([line.mask[0], line.mask[3]], [2, 1]);
  line.updateMask(2, [0]);
  assert.equal(line.capacityVersion, capacity + 1, 'updates never reallocate');
  assert.equal(line.isSelected(2), false);
  line.setPositions([...strip, 4, 1, 0, 5, 0, 0]);
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((i) => line.isSelected(i)),
    [true, false, false, true, true, true],
  );
  assert.equal(line.material.dashed, true, 'the style is untouched');
  assert.throws(() => line.setMask([1, 1]), RangeError);
  assert.throws(() => line.updateMask(5, [1, 1]), RangeError);
  line.setMask(null);
  assert.equal(line.mask, null);
  assert.throws(() => line.updateMask(0, [1]), /setMask/);
});

test('the line, ribbon and pick shaders gate on the mask, so every style and picks honour it', () => {
  const { lines, frame, setup } = rig();
  lines.add(new Line({ positions: strip }));
  const flat = lines.add(new Line({ positions: strip }));
  flat.flatNormal = [0, 0, 1];
  const modules = [...setup, ...frame()].filter((e) => e[0] === 'module').map((e) => e[2].code);
  const lineShader = modules[0],
    ribbon = modules.find((code) => code.includes('fn ribbonVertex'));
  assert.ok(ribbon, 'a ribbon module was made');
  for (const code of [lineShader, ribbon, linePickShader()]) {
    assert.match(code, /@group\(1\) @binding\(7\) var<storage,read> margoMask/);
    assert.match(code, /if\(margoMaskPresent\(\)\)\{let on=margoMaskOn\(ia\)&&margoMaskOn\(ib\);/);
  }
  assert.match(ribbon, /let on=margoMaskOn\(ii\)&&margoMaskOn\(ii\+1u\);/);
});

test('every line binds a mask: its own, or a zeroed stand-in; a change uploads only the mask, once', () => {
  const { lines, frame, gpu } = rig();
  const plain = lines.add(new Line({ positions: strip })),
    masked = lines.add(new Line({ positions: strip, width: 4 }));
  masked.setMask([1, 1, 0, 1]);
  const first = frame();
  const groups = first.filter((e) => e[0] === 'group');
  assert.equal(groups.length, 2);
  for (const group of groups)
    assert.ok(
      group[2].entries.some((e) => e.binding === 7),
      'binding 7 in every group',
    );
  assert.notEqual(
    groups[0][2].entries.find((e) => e.binding === 7).resource.buffer,
    groups[1][2].entries.find((e) => e.binding === 7).resource.buffer,
  );
  assert.equal(frame().filter((e) => e[0] === 'writeBuffer').length, 0, 'a steady frame writes nothing');
  masked.updateMask(0, [0, 0, 0, 0]);
  const changed = frame();
  assert.deepEqual(
    changed.filter((e) => e[0] === 'writeBuffer').map((e) => e[3].length / 2),
    [20],
    'one write of the 20-byte mask',
  );
  assert.equal(changed.filter((e) => e[0] === 'renderPipeline' || e[0] === 'group').length, 0);
  assert.ok(plain.mask === null && gpu);
});
