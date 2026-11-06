import test from 'node:test';
import assert from 'node:assert/strict';
import { Line, LineMaterial } from '../dist/index.js';
import { rig } from './gpu-rig.js';

const positions = [0, 0, 0, 1, 0, 0];
const modules = (log) => log.filter((e) => e[0] === 'module').map((e) => e[2].code);

test('round and square dash ends compile a shader of their own, butt and solid lines the plain one', () => {
  const round = rig(),
    square = rig(),
    butt = rig(),
    solid = rig();
  round.lines.add(new Line({ positions, dashed: true, dashCap: 'round' }));
  square.lines.add(new Line({ positions, dashed: true, dashCap: 'square' }));
  butt.lines.add(new Line({ positions, dashed: true }));
  solid.lines.add(new Line({ positions, dashCap: 'round' }));
  const code = (r) => modules(r.frame())[0];
  assert.match(code(round), /let sd=sqrt\(past\*past\+i\.edge\.x\*i\.edge\.x\)-i\.edge\.y;/);
  assert.match(code(square), /let past=inside\/fw\+i\.edge\.y;/);
  assert.equal(modules(butt.frame()).length, 0, 'butt ends use the module made at setup');
  assert.equal(modules(solid.frame()).length, 0, 'a line with no dashes has no dash ends');
});

test('dashCap is checked and defaults to butt', () => {
  assert.equal(new LineMaterial().dashCap, 'butt');
  assert.throws(() => new LineMaterial({ dashCap: 'point' }), TypeError);
});
