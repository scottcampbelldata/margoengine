import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Stats } from '../dist/index.js';

function overlay(t) {
  const dom = new JSDOM('<body></body>');
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  const stats = new Stats({ parent: dom.window.document.body });
  t.after(() => {
    stats.dispose();
    dom.window.close();
  });
  return stats;
}

function encoder(stats, render, compute) {
  const value = {
    beginRenderPass() {
      return render;
    },
    beginComputePass() {
      return compute;
    },
    finish() {},
  };
  stats.track(value);
  return value;
}

test('native-like passes retain every captured method after prototype mutation', (t) => {
  const stats = overlay(t),
    calls = [],
    buffer = {};
  class Render {
    draw(...args) {
      calls.push(['draw', this, args]);
    }
    drawIndexed(...args) {
      calls.push(['indexed', this, args]);
    }
    drawIndirect(...args) {
      calls.push(['indirect', this, args]);
    }
    drawIndexedIndirect(...args) {
      calls.push(['indexedIndirect', this, args]);
    }
  }
  class Compute {
    dispatchWorkgroups(...args) {
      calls.push(['dispatch', this, args]);
    }
    dispatchWorkgroupsIndirect(...args) {
      calls.push(['dispatchIndirect', this, args]);
    }
  }
  const render = new Render(),
    compute = new Compute(),
    tracked = encoder(stats, render, compute);
  tracked.beginRenderPass({ colorAttachments: [] });
  tracked.beginComputePass();
  for (const name of ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect'])
    Render.prototype[name] = function () {
      throw new Error('replacement render method');
    };
  for (const name of ['dispatchWorkgroups', 'dispatchWorkgroupsIndirect'])
    Compute.prototype[name] = function () {
      throw new Error('replacement compute method');
    };
  tracked.beginRenderPass({ colorAttachments: [] });
  tracked.beginComputePass();
  render.draw(3);
  render.drawIndexed(6, 2, 3, -1, 4);
  render.drawIndirect(buffer, 16);
  render.drawIndexedIndirect(buffer, 32);
  compute.dispatchWorkgroups(8);
  compute.dispatchWorkgroupsIndirect(buffer, 64);
  assert.equal(stats.drawCalls, 4);
  assert.equal(stats.dispatches, 2);
  assert.deepEqual(calls, [
    ['draw', render, [3, 1, 0, 0]],
    ['indexed', render, [6, 2, 3, -1, 4]],
    ['indirect', render, [buffer, 16]],
    ['indexedIndirect', render, [buffer, 32]],
    ['dispatch', compute, [8, 1, 1]],
    ['dispatchIndirect', compute, [buffer, 64]],
  ]);
});

test('new prototype method versions do not alter previously wrapped passes', (t) => {
  const stats = overlay(t),
    calls = [];
  class Render {
    draw() {
      calls.push('draw');
    }
    drawIndexed() {
      calls.push('old-indexed');
    }
    drawIndirect() {}
    drawIndexedIndirect() {}
  }
  class Compute {
    dispatchWorkgroups() {
      calls.push('dispatch');
    }
    dispatchWorkgroupsIndirect() {
      calls.push('old-indirect');
    }
  }
  const firstRender = new Render(),
    firstCompute = new Compute();
  const first = encoder(stats, firstRender, firstCompute);
  first.beginRenderPass({ colorAttachments: [] });
  first.beginComputePass();
  // Keep the cache's first method identity while replacing a different method.
  Render.prototype.drawIndexed = function () {
    calls.push('new-indexed');
  };
  Compute.prototype.dispatchWorkgroupsIndirect = function () {
    calls.push('new-indirect');
  };
  const secondRender = new Render(),
    secondCompute = new Compute();
  const second = encoder(stats, secondRender, secondCompute);
  second.beginRenderPass({ colorAttachments: [] });
  second.beginComputePass();
  firstRender.drawIndexed(3);
  secondRender.drawIndexed(3);
  firstCompute.dispatchWorkgroupsIndirect({}, 0);
  secondCompute.dispatchWorkgroupsIndirect({}, 0);
  assert.deepEqual(calls, ['old-indexed', 'new-indexed', 'old-indirect', 'new-indirect']);
  assert.equal(stats.drawCalls, 2);
  assert.equal(stats.dispatches, 2);
});

test('repeated wrapping preserves instance overrides and counts each command once', (t) => {
  const stats = overlay(t),
    calls = [];
  class Render {
    draw() {
      throw new Error('prototype draw');
    }
    drawIndexed() {}
    drawIndirect() {}
    drawIndexedIndirect() {}
  }
  class Compute {
    dispatchWorkgroups() {
      throw new Error('prototype dispatch');
    }
    dispatchWorkgroupsIndirect() {}
  }
  const render = new Render(),
    compute = new Compute();
  render.draw = function (...args) {
    assert.equal(this, render);
    calls.push(['draw', args]);
  };
  compute.dispatchWorkgroups = function (...args) {
    assert.equal(this, compute);
    calls.push(['dispatch', args]);
  };
  const tracked = encoder(stats, render, compute);
  tracked.beginRenderPass({ colorAttachments: [] });
  tracked.beginComputePass();
  const draw = render.draw,
    dispatch = compute.dispatchWorkgroups;
  for (let i = 0; i < 3; i++) {
    // An already wrapped pass keeps its original capture when wrapped again.
    render.draw = function () {
      throw new Error('later override');
    };
    compute.dispatchWorkgroups = function () {
      throw new Error('later override');
    };
    tracked.beginRenderPass({ colorAttachments: [] });
    tracked.beginComputePass();
    assert.equal(render.draw, draw);
    assert.equal(compute.dispatchWorkgroups, dispatch);
    render.draw(3);
    compute.dispatchWorkgroups(2);
  }
  assert.equal(stats.drawCalls, 3);
  assert.equal(stats.dispatches, 3);
  assert.deepEqual(calls, [
    ['draw', [3, 1, 0, 0]],
    ['dispatch', [2, 1, 1]],
    ['draw', [3, 1, 0, 0]],
    ['dispatch', [2, 1, 1]],
    ['draw', [3, 1, 0, 0]],
    ['dispatch', [2, 1, 1]],
  ]);
});

test('shared passes move between Stats owners without capturing another wrapper', (t) => {
  const firstStats = overlay(t),
    secondStats = overlay(t);
  let draws = 0,
    dispatches = 0;
  class Render {
    draw() {
      draws++;
    }
    drawIndexed() {}
    drawIndirect() {}
    drawIndexedIndirect() {}
  }
  class Compute {
    dispatchWorkgroups() {
      dispatches++;
    }
    dispatchWorkgroupsIndirect() {}
  }
  const render = new Render(),
    compute = new Compute();
  const first = encoder(firstStats, render, compute),
    second = encoder(secondStats, render, compute);
  for (const tracked of [first, second, first, second]) {
    tracked.beginRenderPass({ colorAttachments: [] });
    tracked.beginComputePass();
    render.draw(3);
    compute.dispatchWorkgroups(1);
  }
  assert.equal(draws, 4);
  assert.equal(dispatches, 4);
  assert.equal(firstStats.drawCalls, 2);
  assert.equal(secondStats.drawCalls, 2);
  assert.equal(firstStats.dispatches, 2);
  assert.equal(secondStats.dispatches, 2);
});
