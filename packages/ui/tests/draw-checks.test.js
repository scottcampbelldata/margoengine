// DrawList checks its commands before appending them: NaN geometry used to pass the empty test (NaN compares false)
// and reach the GPU as NaN vertices, and a popClip with no clip open was dropped silently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DrawList } from '../dist/index.js';

const BAD = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
const style = { fill: [1, 1, 1, 1] };
const snapshot = (list) => ({ version: list.version, commands: JSON.stringify(list.commands) });

function refused(list, call, what) {
  const before = snapshot(list);
  assert.throws(call, (error) => error instanceof RangeError && /; pass /.test(error.message), what);
  assert.deepEqual(snapshot(list), before, `${what}: the list is unchanged`);
}

test('rect and pushClip refuse non-finite geometry, and the list is unchanged', () => {
  const list = new DrawList();
  list.clear(2);
  list.rect(1, 1, 4, 4, style);
  for (const v of BAD) {
    for (let at = 0; at < 4; at++) {
      const args = [1, 1, 4, 4];
      args[at] = v;
      refused(list, () => list.rect(...args, style), `rect argument ${at} = ${v}`);
      refused(list, () => list.pushClip(...args), `pushClip argument ${at} = ${v}`);
    }
    for (const key of ['borderWidth', 'radius', 'blur'])
      refused(list, () => list.rect(1, 1, 4, 4, { ...style, [key]: v }), `rect ${key} = ${v}`);
  }
  assert.equal(list.commands.length, 1);
});

test('text refuses a non-finite position and clear a scale that is not finite and above 0', () => {
  const list = new DrawList();
  list.clear(1);
  const layout = { glyphs: [{}], width: 1, height: 1 };
  for (const v of BAD) {
    refused(list, () => list.text(v, 0, layout, {}, [1, 1, 1, 1]), `text x = ${v}`);
    refused(list, () => list.text(0, v, layout, {}, [1, 1, 1, 1]), `text y = ${v}`);
  }
  for (const v of [...BAD, 0, -1]) refused(list, () => list.clear(v), `clear(${v})`);
});

test('popClip with no clip open throws, and a matched pair still works', () => {
  const list = new DrawList();
  list.clear(1);
  refused(list, () => list.popClip(), 'popClip on an empty clip stack');
  list.pushClip(0, 0, 10, 10);
  list.popClip();
  assert.deepEqual(
    list.commands.map((c) => c.type),
    ['clip', 'unclip'],
  );
  refused(list, () => list.popClip(), 'a second popClip');
});
