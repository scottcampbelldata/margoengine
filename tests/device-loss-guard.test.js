// Bug 25 (2026-10-27): GPU resets on this PC removed one page's WebGPU device at a time and the check timed out with no
// word about the GPU. scripts/support/device-loss.js's page init script reports every device lost other than by
// destroy(); this runs it against a stand-in WebGPU adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceLossGuard, deviceLossMessage, resetsAround } from '../scripts/support/device-loss.js';

function adapterWith(lostInfo) {
  class GPUAdapter {
    async requestDevice() {
      return { lost: Promise.resolve(lostInfo), destroy() {} };
    }
  }
  return GPUAdapter;
}

async function reports(lostInfo) {
  const saved = { adapter: globalThis.GPUAdapter, debug: console.debug },
    lines = [];
  globalThis.GPUAdapter = adapterWith(lostInfo);
  console.debug = (line) => lines.push(line);
  try {
    deviceLossGuard();
    deviceLossGuard(); // installed once, however many times the script runs
    const device = await new globalThis.GPUAdapter().requestDevice();
    assert.equal(typeof device.destroy, 'function', 'the page gets the device itself');
    await device.lost;
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    globalThis.GPUAdapter = saved.adapter;
    console.debug = saved.debug;
  }
  return lines;
}

test('a device the driver removes is reported once with its reason, message and time', async () => {
  const lines = await reports({ reason: 'unknown', message: 'D3D12 device removed (DXGI_ERROR_DEVICE_REMOVED)' });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[gpu\] lost /);
  const loss = JSON.parse(lines[0].slice('[gpu] lost '.length));
  assert.equal(loss.reason, 'unknown');
  assert.equal(loss.message, 'D3D12 device removed (DXGI_ERROR_DEVICE_REMOVED)');
  assert.ok(!Number.isNaN(Date.parse(loss.at)));
});

test('destroy() is the page losing its device on purpose (restore checks): not reported', async () => {
  assert.deepEqual(await reports({ reason: 'destroyed', message: 'Device was destroyed.' }), []);
});

test('the failure message says what happened and what to do', () => {
  const text = deviceLossMessage({ reason: 'unknown', message: 'hung', at: '2026-10-27T13:53:29Z' });
  assert.match(text, /WebGPU device was lost at \d\d:\d\d:\d\d \(reason "unknown": hung\)/);
  assert.match(text, /GPU reset/);
  assert.match(text, /Run the check again/);
});

// Bug 25 (2026-10-28): right after a reset the next page to ask for a device is refused ("D3D12 create command queue
// failed with E_OUTOFMEMORY"), and sciviz failed on that with no word about the reset: a refused requestDevice with a
// driver error is reported as a loss too, and the message names the reset the event log shows, or says none was logged.
function refusingAdapter(error) {
  class GPUAdapter {
    async requestDevice() {
      throw error;
    }
  }
  return GPUAdapter;
}

async function refusal(error) {
  const saved = { adapter: globalThis.GPUAdapter, debug: console.debug },
    lines = [];
  globalThis.GPUAdapter = refusingAdapter(error);
  console.debug = (line) => lines.push(line);
  try {
    deviceLossGuard();
    await assert.rejects(new globalThis.GPUAdapter().requestDevice(), (thrown) => thrown === error);
  } finally {
    globalThis.GPUAdapter = saved.adapter;
    console.debug = saved.debug;
  }
  return lines;
}

test('a requestDevice the driver refuses is reported (and still rejects); a bad descriptor is not', async () => {
  const driver = new Error(
    "Failed to execute 'requestDevice' on 'GPUAdapter': D3D12 create command queue failed with E_OUTOFMEMORY (0x8007000E)",
  );
  const lines = await refusal(driver);
  assert.equal(lines.length, 1);
  const loss = JSON.parse(lines[0].slice('[gpu] lost '.length));
  assert.equal(loss.reason, 'request-failed');
  assert.match(loss.message, /E_OUTOFMEMORY/);
  assert.deepEqual(await refusal(new TypeError("Failed to read the 'requiredLimits' property")), []);
});

const reset = { at: '2026-10-28T05:21:49.188Z', source: 'nvlddmkm', id: '153', detail: 'Error occurred on GPUID: 100' };

test('the message names the driver reset from the event log', () => {
  const text = deviceLossMessage(
    {
      reason: 'request-failed',
      message: 'D3D12 create command queue failed with E_OUTOFMEMORY',
      at: '2026-10-28T05:21:47Z',
    },
    [reset],
  );
  assert.match(
    text,
    /could not get a WebGPU device at \d\d:\d\d:47 \(requestDevice failed: D3D12 create command queue/,
  );
  assert.match(
    text,
    /the GPU driver reset the GPU \(GPU driver reset in the Windows event log: nvlddmkm event 153 at \d\d:\d\d:49\)/,
  );
  assert.match(text, /check:merge runs the step once more/);
});

test('with no reset in the event log the message says so and points at the browser or the page', () => {
  const text = deviceLossMessage({ reason: 'unknown', message: 'hung', at: '2026-10-28T05:21:47Z' }, []);
  assert.match(text, /No GPU driver reset is logged in the Windows event log around then/);
  assert.match(text, /GPU process|own GPU work/);
  assert.doesNotMatch(text, /the GPU driver reset the GPU/);
});

test('the lookup waits for the driver to log its reset, and gives up after its settle time', async () => {
  const loss = { reason: 'unknown', at: '2026-10-28T05:21:47Z' };
  let calls = 0;
  const later = () => (++calls < 3 ? [] : [reset]);
  assert.deepEqual(await resetsAround(loss, { lookup: later, settleMs: 5000, poll: 1, platform: 'win32' }), [reset]);
  assert.equal(calls, 3);
  calls = 0;
  const never = () => (calls++, []);
  assert.deepEqual(await resetsAround(loss, { lookup: never, settleMs: 20, poll: 5, platform: 'win32' }), []);
  assert.ok(calls >= 2);
  assert.equal(await resetsAround(loss, { lookup: never, platform: 'linux' }), undefined);
});
