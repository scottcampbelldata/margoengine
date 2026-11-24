import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { model, parseSTEP } from '../dist/index.js';

// Damaged copies of an 80 x 50 x 8 mm plate (32000 mm3), from the kernel comparison's malformed and fuzzed files.
const fixture = (name) => readFileSync(new URL(`./fixtures/step/${name}.step`, import.meta.url), 'latin1');

test('STEP: a reference to an instance never defined is named in a warning; the body is left out, not empty', () => {
  // MANIFOLD_SOLID_BREP('Plate',#99999): the shell was read as no faces, an empty solid of 0 mm3 with no warning.
  const step = parseSTEP(fixture('dangling-shell'));
  assert.equal(step.bodies.length, 1);
  assert.deepEqual(step.bodies[0].unresolved, [99999]);
  assert.ok(
    step.warnings.some((w) => w.includes('#99999') && w.includes('#132 MANIFOLD_SOLID_BREP')),
    JSON.stringify(step.warnings),
  );
  const imported = model.bodiesFromSTEP(step);
  assert.equal(imported.bodies[0], undefined);
  assert.match(imported.problems[0].problem, /#132: refers to #99999, which the file never defines/);
  // Reading an instance that is not there names what refers to it.
  assert.throws(() => step.file.get(99999), /#99999 is referenced by #132 MANIFOLD_SOLID_BREP but never defined/);
});

test('STEP: a face reference never defined leaves the body out rather than short of a face', () => {
  const text = fixture('dangling-shell').replace('#99999', '#131');
  assert.equal(model.bodiesFromSTEP(parseSTEP(text)).problems.length, 0);
  const step = parseSTEP(text.replace('#131=CLOSED_SHELL(\'\',(#43,', "#131=CLOSED_SHELL('',(#4300,"));
  assert.deepEqual(step.bodies[0].unresolved, [4300]);
  assert.ok(step.warnings.some((w) => w.includes('#4300') && w.includes('#131 CLOSED_SHELL')));
  assert.equal(model.bodiesFromSTEP(step).bodies[0], undefined);
});

test('STEP: an instance missing its ";" or with an extra ")" throws, naming it, not taking in the next ones', () => {
  // Fuzzed: '#65=L,#5,#64);' swallowed the instances after it up to the next ';' at depth 0, and '#130=...#123#131=...'
  // took #131 in; the solid's shell #131 went missing and the plate read as an empty solid.
  assert.throws(() => parseSTEP(fixture('fuzz-unbalanced')), /#65: '\)' with no '\(' open/);
  const base = fixture('dangling-shell').replace('#99999', '#131');
  assert.throws(
    () => parseSTEP(base.replace("#130=ADVANCED_FACE('',(#129),#123,.T.);", "#130=ADVANCED_FACE('',(#129),#123")),
    /#130: '=' inside the instance/,
  );
});

test('STEP: a solid in no placed representation is named in a warning', () => {
  // Fuzzed: the representation lists an edge loop where the solid was; the file read as no bodies and no warning.
  const step = parseSTEP(fixture('fuzz-unplaced-solid'));
  assert.equal(step.bodies.length, 0);
  assert.ok(step.warnings.some((w) => w.includes("#132 MANIFOLD_SOLID_BREP 'Plate'")), JSON.stringify(step.warnings));
});

test('STEP: a shell listing itself as a face, and lists nested past any real file, give clean errors', () => {
  // The shell read as its own face reached an unset reference: '#-1 is referenced but never defined'.
  const imported = model.bodiesFromSTEP(parseSTEP(fixture('shell-in-itself')));
  assert.equal(imported.bodies[0], undefined);
  assert.match(imported.problems[0].problem, /#131 is a CLOSED_SHELL where its shell needs a face/);
  // 20000 nested lists overflowed the call stack (RangeError: Maximum call stack size exceeded).
  const nested = `${'('.repeat(20000)}0.${')'.repeat(20000)}`,
    deep = fixture('dangling-shell').replace("#1=CARTESIAN_POINT('',(0.,0.,0.));", `#1=CARTESIAN_POINT('',${nested});`);
  assert.throws(
    () => parseSTEP(deep).file.get(1),
    (e) => e instanceof TypeError && /nested more than 256 deep/.test(e.message),
  );
});

test('STEP: a unit context the reader cannot read is refused, never taken as metres', () => {
  // Fuzzed: GLOBAL_UNIT_ASSI9GNED_CONTEXT. The plate read in metres, 3.2e13 mm3 for 32000.
  assert.throws(
    () => parseSTEP(fixture('fuzz-unit-context')),
    (e) => e instanceof TypeError && /context #141 .*_ASSI9GNED_CONTEXT.* assigns no length unit/.test(e.message),
  );
  const plate = fixture('dangling-shell').replace('#99999', '#131');
  assert.equal(parseSTEP(plate).bodies[0].unit, 0.001);
  // A length unit the reader cannot read, and a representation with no context: refused the same way.
  const meter = plate.replace('SI_UNIT(.MILLI.,.METRE.)', 'SI_UNIT(.MILLI.,.METER.)');
  assert.throws(() => parseSTEP(meter), /no length unit/);
  assert.throws(() => parseSTEP(plate.replace("(#136,#132),#141);", '(#136,#132),$);')), /has no context/);
  // No plane-angle unit: warned of and left unknown; the plate, which has no angles, reads exactly, and a cone's half
  // angle is refused rather than taken in radians.
  const noAngle = (text) => text.replace(/GLOBAL_UNIT_ASSIGNED_CONTEXT\(\((#\d+),#\d+(,#\d+)?\)\)/, (m, a, c) =>
    `GLOBAL_UNIT_ASSIGNED_CONTEXT((${a}${c ?? ''}))`);
  const step = parseSTEP(noAngle(plate));
  assert.ok(step.warnings.some((w) => w.includes('context #141: no plane-angle unit')), JSON.stringify(step.warnings));
  assert.ok(Number.isNaN(step.bodies[0].angleUnit));
  const volume = model.massProperties(model.bodiesFromSTEP(step).bodies[0]).volume / 1e-9;
  assert.ok(Math.abs(volume - 32000) < 1e-9 * 32000, `${volume}`);
  const line = (x, z) => ({ kind: 'line', to: [x * 1e-3, 0, z * 1e-3] }),
    frustum = model.revolve(
      'f',
      { name: 'p', start: [2e-3, 0, 0], normal: [0, 1, 0], segments: [line(5, 0), line(3, 4), line(2, 4), line(2, 0)] },
      { origin: [0, 0, 0], direction: [0, 0, 1] },
    ),
    written = model.bodiesToSTEP([frustum]);
  assert.match(written, /CONICAL_SURFACE/);
  assert.deepEqual(model.bodiesFromSTEP(parseSTEP(written)).problems, []);
  const cone = model.bodiesFromSTEP(parseSTEP(noAngle(written)));
  assert.equal(cone.bodies[0], undefined);
  assert.match(cone.problems[0].problem, /gives an angle, and the file's context no plane-angle unit for it/);
});

test('STEP: a face on the wrong surface is flagged, each edge by the most it is off, while its volume follows its edges', () => {
  // The fuzz case m162: the plate's top face #70 refers to the plane #74 (y = 0, the front's) in place of its own #47
  // (z = 8 mm), and a direction gains the label '82'. The top's edges #56, #61 and #66 run up to 50 mm off y = 0
  // (#51 lies in it); each was reported by its first sample past the tolerance (12.5 mm for #56 and #66).
  const good = fixture('dangling-shell').replace('#99999', '#131'),
    text = good
      .replace("#70=ADVANCED_FACE('',(#69),#47,.T.);", "#70=ADVANCED_FACE('',(#69),#74,.T.);")
      .replace("#109=DIRECTION('',(-1.,0.,0.));", "#109=DIRECTION('82',(-1.,0.,0.));");
  assert.notEqual(text, good);
  const imported = model.bodiesFromSTEP(parseSTEP(text)),
    [plate] = imported.bodies,
    problems = model.checkBody(plate);
  assert.deepEqual(
    problems.map((p) => [p.name, p.problem]),
    ['#56', '#61', '#66'].map((e) => [`Plate/edge:${e}`, '5.00e-2 m off the surface of Plate/face:#70']),
  );
  assert.deepEqual(
    imported.problems.map((p) => p.problem),
    problems.map((p) => `${p.name}: ${p.problem}`),
  );
  // The volume integrates strips from each edge's foot on its face to the edge, so it is the one the edges bound.
  assert.ok(Math.abs(model.massProperties(plate).volume / 1e-9 - 32000) <= 1e-9 * 32000);
  const [whole] = model.bodiesFromSTEP(parseSTEP(good)).bodies;
  assert.deepEqual(model.checkBody(whole), []);
  assert.ok(Math.abs(model.massProperties(whole).volume / 1e-9 - 32000) <= 1e-9 * 32000);
});
