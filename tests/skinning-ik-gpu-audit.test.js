import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { attachGPUAudit } from '../examples/skinning-ik/gpu-audit.ts';

function fixture(t) {
  const dom = new JSDOM(
    '<body><div id="viewport"></div><input id="look" type="checkbox"><button id="view-back">Back</button></body>',
  );
  const parent = dom.window.document.querySelector('#viewport');
  let time = 0,
    frame,
    timer,
    removed = 0,
    disconnected = 0,
    cleared = 0,
    resize;
  t.mock.method(dom.window.performance, 'now', () => time);
  t.mock.method(globalThis, 'setInterval', (callback, milliseconds) => {
    assert.equal(milliseconds, 500);
    timer = callback;
    return 123;
  });
  const clear = globalThis.clearInterval;
  t.mock.method(globalThis, 'clearInterval', (id) => {
    if (id === 123) cleared++;
    else clear(id);
  });
  dom.window.ResizeObserver = class {
    constructor(callback) {
      resize = callback;
    }
    observe() {}
    disconnect() {
      disconnected++;
    }
  };
  const stats = {
    gpuSampleId: 0,
    gpuSampleEncodedAt: null,
    gpuSampleReadAt: null,
    gpuTime: null,
    gpuElapsedMilliseconds: null,
    gpuPassMilliseconds: new Float64Array(128),
    gpuPassCount: 0,
    drawCalls: 52,
    dispatches: 8,
    sampleIndex: 12,
  };
  const audit = attachGPUAudit(stats, parent, {
    engine: {
      onFrame(callback) {
        frame = callback;
        return () => {
          removed++;
        };
      },
    },
    report: () => ({ reflectionBusy: false, probeEncodeMs: 2, probeTotalMs: 8 }),
  });
  t.after(() => {
    audit.dispose();
    dom.window.close();
  });
  const complete = (id, encodedAt = time, duration = 2.8) => {
    Object.assign(stats, {
      gpuSampleId: id,
      gpuSampleEncodedAt: encodedAt,
      gpuSampleReadAt: time,
      gpuTime: duration,
      gpuElapsedMilliseconds: duration + 1,
      gpuPassCount: 3,
    });
    stats.gpuPassMilliseconds.set([0.5, duration - 0.8, 0.3]);
  };
  return {
    dom,
    parent,
    stats,
    audit,
    complete,
    setTime(value) {
      time = value;
    },
    frame() {
      frame();
    },
    timer() {
      timer();
    },
    resize() {
      resize();
    },
    removed: () => removed,
    disconnected: () => disconnected,
    cleared: () => cleared,
  };
}

test('GPU audit correlates exact encoded samples with preceding actions without assigning a cause or pass label', (t) => {
  const f = fixture(t),
    { document } = f.dom.window;
  f.setTime(10);
  document.querySelector('#look').checked = true;
  document.querySelector('#look').dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
  f.setTime(30);
  document.querySelector('#view-back').click(); // after the sampled encoder's finish; must not be attributed backwards
  f.setTime(50);
  f.complete(1, 20);
  f.frame();
  const data = f.audit.snapshot();
  assert.match(data.interpretation, /not proof of causation/);
  assert.match(data.passMeaning, /labels are unavailable/);
  assert.match(data.timestampMeaning, /CPU/);
  assert.equal(data.latest.id, 1);
  assert.equal(data.latest.precedingAction.target, '#look');
  assert.equal(data.latest.precedingAction.ageAtEncodingMs, 10);
  assert.equal(data.latest.largestPass.index, 1);
  assert.ok(Math.abs(data.latest.largestPass.milliseconds - 2) < 1e-12);
  assert.equal(data.latest.contextObservedNow.probeEncodeMs, 2);
  assert.deepEqual(data.latest.currentCounters, { drawCalls: 52, dispatches: 8, cpuSampleIndex: 12 });
  assert.equal(f.parent.children.length, 0, 'diagnostics must not add visible UI');
  assert.equal(JSON.parse(f.parent.dataset.gpuAudit).observedSamples, 0, 'DOM writes are throttled');
  f.setTime(500);
  f.frame();
  assert.equal(JSON.parse(f.parent.dataset.gpuAudit).latest.id, 1);
});

test('GPU audit counts equal-duration completions once, reports skipped IDs, and bounds recent history', (t) => {
  const f = fixture(t);
  for (let id = 1; id <= 30; id++) {
    f.setTime(id * 20);
    f.audit.mark('preset', id);
    f.complete(id);
    f.frame();
    f.frame();
  }
  let data = f.audit.snapshot();
  assert.equal(data.observedSamples, 30);
  assert.equal(data.recentSamples.length, 20);
  assert.equal(data.recentActions.length, 20);
  assert.equal(data.skippedSampleIds, 0);
  assert.equal(data.peakObservedSinceAttach.id, 1);
  f.setTime(700);
  f.complete(34, 690, 8);
  f.frame();
  data = f.audit.snapshot();
  assert.equal(data.skippedSampleIds, 3);
  assert.equal(data.peakObservedSinceAttach.passSumMs, 8);
  f.stats.gpuTime = null;
  f.stats.gpuSampleEncodedAt = f.stats.gpuSampleReadAt = null;
  f.frame();
  assert.equal(f.audit.snapshot().observedSamples, 31, 'invalid or pending timing is not another sample');
});

test('GPU audit observes resize and pointer state, then removes all observers/listeners on disposal', (t) => {
  const f = fixture(t),
    { document, Event } = f.dom.window;
  const pointer = (type) => {
    const e = new Event(type, { bubbles: true });
    Object.assign(e, { pointerId: 7, pointerType: 'mouse' });
    f.parent.dispatchEvent(e);
  };
  pointer('pointerdown');
  assert.equal(f.audit.snapshot().activePointers, 1);
  pointer('pointerup');
  assert.equal(f.audit.snapshot().activePointers, 0);
  f.resize();
  f.resize();
  assert.equal(f.audit.snapshot().recentActions.at(-1).type, 'viewport-resize');
  f.audit.dispose();
  assert.equal(f.removed(), 1);
  assert.equal(f.disconnected(), 1);
  assert.equal(f.cleared(), 1);
  assert.equal(f.parent.dataset.gpuAudit, undefined);
  const count = f.audit.snapshot().recentActions.length;
  document.querySelector('#view-back').click();
  f.audit.mark('after-dispose');
  f.complete(1);
  f.frame();
  f.timer();
  assert.equal(f.audit.snapshot().recentActions.length, count);
  assert.equal(f.audit.snapshot().observedSamples, 0);
});
