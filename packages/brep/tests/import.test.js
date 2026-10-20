import assert from 'node:assert/strict';
import { test } from 'node:test';
import { model, parseSTEP } from '../dist/index.js';

const {
  bodiesFromSTEP,
  bodiesToSTEP,
  boolean,
  box,
  cylinder,
  fillet,
  frameOf,
  massProperties,
  sphere,
  torus,
  validateBody,
} = model;
const mm = 0.001,
  up = (x, y, z) => frameOf([x * mm, y * mm, z * mm], [0, 0, 1], [1, 0, 0]);

/** Exports bodies to STEP, reads the file back and imports its bodies into the modeler. */
function roundTrip(bodies) {
  const step = parseSTEP(bodiesToSTEP(bodies)),
    imported = bodiesFromSTEP(step);
  assert.deepEqual(imported.problems, []);
  return imported.bodies;
}

test('STEP import: bodies built here come back from their STEP export valid, with the same volume and area', () => {
  const cube = () => box('a', [10 * mm, 10 * mm, 10 * mm]),
    originals = [
      box('b', [10 * mm, 20 * mm, 30 * mm], up(5, -7, 2)),
      cylinder('c', 5 * mm, 10 * mm),
      sphere('s', 5 * mm),
      torus('t', 10 * mm, 3 * mm),
      boolean('p', 'subtract', box('b', [20 * mm, 20 * mm, 10 * mm]), cylinder('h', 3 * mm, 20 * mm, up(10, 10, -5))),
      fillet(
        'rb',
        cube(),
        cube().edges.map((e) => e.name),
        2 * mm,
      ),
    ],
    back = roundTrip(originals);
  assert.equal(back.length, originals.length);
  back.forEach((body, i) => {
    assert.ok(body, `body ${i} imported`);
    assert.equal(body.kind, 'solid');
    assert.deepEqual(validateBody(body), [], `body ${i} valid`);
    const a = massProperties(originals[i]),
      b = massProperties(body);
    assert.ok(Math.abs(b.volume - a.volume) <= 1e-9 * a.volume, `body ${i} volume ${b.volume} vs ${a.volume}`);
    assert.ok(Math.abs(b.area - a.area) <= 1e-9 * a.area, `body ${i} area ${b.area} vs ${a.area}`);
  });
});

test('STEP import: hemispheres in turned frames keep their volume (a seam cut through an equator vertex)', () => {
  // The export cuts each sphere's seam through a vertex of its equator, so the re-read loop can start a rounding error
  // past u = 0; the pole test once missed such a loop and counted a hemisphere as covering both poles, or neither.
  for (let k = 0; k < 16; k++)
    for (const z of [0, -10]) {
      const a = (k * Math.PI) / 8,
        half = boolean(
          'h',
          'intersect',
          sphere('s', 5 * mm, frameOf([0, 0, 0], [0, 0, 1], [Math.cos(a), Math.sin(a), 0])),
          box('b', [20 * mm, 20 * mm, 10 * mm], up(-10, -10, z)),
        ),
        [back] = roundTrip([half]),
        want = massProperties(half).volume,
        got = massProperties(back).volume;
      assert.ok(Math.abs(got - want) <= 1e-9 * want, `turned ${k} pi / 8, z ${z}: volume ${got} vs ${want}`);
    }
});

test('STEP import: an imported part takes modeling operations (a hole drilled, its edges rounded)', () => {
  const [plate] = roundTrip([box('b', [20 * mm, 20 * mm, 10 * mm])]),
    drilled = boolean('d', 'subtract', plate, cylinder('h', 3 * mm, 20 * mm, up(10, 10, -5)));
  assert.deepEqual(validateBody(drilled), []);
  assert.ok(Math.abs(massProperties(drilled).volume / mm ** 3 - (4000 - Math.PI * 90)) < 1e-6);
  const top = drilled.edges.filter(
      (e) => e.curve.kind === 'line' && e.start.point[2] > 9.999 * mm && e.end.point[2] > 9.999 * mm,
    ),
    rounded = fillet(
      'r',
      drilled,
      top.map((e) => e.name),
      1 * mm,
    );
  assert.deepEqual(validateBody(rounded), []);
  // Four top edges of 20 mm, each losing (1 - pi / 4) mm2 of section, less the corners where two meet at a mitre.
  assert.ok(massProperties(rounded).volume < massProperties(drilled).volume);
});
