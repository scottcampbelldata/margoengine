import assert from 'node:assert/strict';
import test from 'node:test';
import { Interaction } from '../src/interact.ts';

function fixture() {
  const canvas = Object.assign(new EventTarget(), { style: {} }),
    events = [],
    errors = [];
  let cpu = 0;
  const interaction = new Interaction(
    canvas,
    {},
    {
      pick: () => {
        cpu++;
        return null;
      },
      hover: (hit) => events.push(hit),
      error: (error) => errors.push(error),
      describe: () => null,
      controls: () => undefined,
      select: () => {},
    },
  );
  return { interaction, events, errors, cpu: () => cpu };
}
const drain = () => new Promise((resolve) => setImmediate(resolve));

test('async hover coalesces pointer positions, discards stale results and restores the CPU reference', async () => {
  const f = fixture(),
    a = Promise.withResolvers(),
    b = Promise.withResolvers(),
    calls = [];
  const remove = f.interaction.setPicker((x, y) => {
    calls.push([x, y]);
    return calls.length === 1 ? a.promise : b.promise;
  });
  f.interaction.update(1, 2);
  f.interaction.update(3, 4);
  f.interaction.update(5, 6);
  assert.deepEqual(calls, [[1, 2]]);
  assert.equal(f.cpu(), 0);
  a.resolve({ layer: 1, index: 1 });
  await drain();
  assert.deepEqual(f.events, []);
  assert.deepEqual(calls, [
    [1, 2],
    [5, 6],
  ]);
  b.resolve({ layer: 1, index: 2 });
  await drain();
  assert.deepEqual(f.events, [{ layer: 1, index: 2 }]);
  remove();
  f.interaction.update(1, 2);
  assert.equal(f.cpu(), 1);
  f.interaction.dispose();
});
test('pending hover cannot publish after disposal; failures are reported without poisoning future picks', async () => {
  const f = fixture(),
    pending = Promise.withResolvers();
  f.interaction.setPicker(() => pending.promise);
  f.interaction.update(1, 2);
  f.interaction.dispose();
  pending.resolve({ layer: 1, index: 1 });
  await drain();
  assert.deepEqual(f.events, []);
  const g = fixture(),
    reason = new Error('GPU lost');
  g.interaction.setPicker(() => Promise.reject(reason));
  g.interaction.update(1, 2);
  await drain();
  assert.deepEqual(g.errors, [reason]);
  g.interaction.setPicker(() => Promise.resolve({ layer: 1, index: 2 }));
  g.interaction.update(1, 2);
  await drain();
  assert.deepEqual(g.events, [{ layer: 1, index: 2 }]);
  g.interaction.dispose();
});
test('box and lasso selection follow the pointer that started them and keep touch gestures from the browser', () => {
  const svg = () => ({ style: {}, setAttribute() {}, replaceChildren() {}, remove() {} }),
    saved = globalThis.document;
  globalThis.document = {
    body: { append() {} },
    createElementNS: svg,
  };
  try {
    const canvas = Object.assign(new EventTarget(), {
        style: { touchAction: 'pan-y' },
        offsetLeft: 0,
        offsetTop: 0,
        clientWidth: 100,
        clientHeight: 100,
        parentElement: null,
        getBoundingClientRect: () => ({ left: 0, top: 0 }),
        setPointerCapture() {},
        releasePointerCapture() {},
      }),
      selections = [];
    const interaction = new Interaction(
      canvas,
      { text: '#000000', grid: '#000000', background: '#ffffff' },
      {
        pick: () => null,
        hover() {},
        error() {},
        describe: () => null,
        controls: () => undefined,
        select: (region) => selections.push(region),
      },
    );
    const fire = (type, pointerId, x, y) =>
      canvas.dispatchEvent(Object.assign(new Event(type), { pointerId, clientX: x, clientY: y, button: 0, buttons: 1 }));
    interaction.mode = 'box';
    // A selection drag on a touch screen must not be taken by the browser as a scroll (pointercancel).
    assert.equal(canvas.style.touchAction, 'none');
    fire('pointerdown', 1, 10, 10);
    fire('pointermove', 2, 90, 90);
    fire('pointermove', 1, 30, 40);
    fire('pointerup', 2, 90, 90);
    assert.deepEqual(selections, []);
    fire('pointerup', 1, 30, 40);
    assert.deepEqual(selections, [{ rect: [10, 10, 30, 40] }]);
    interaction.mode = 'orbit';
    assert.equal(canvas.style.touchAction, 'pan-y');
    interaction.mode = 'lasso';
    interaction.dispose();
    assert.equal(canvas.style.touchAction, 'pan-y');
  } finally {
    globalThis.document = saved;
  }
});
