// Bug 25 (2026-10-27): GPU resets on this PC removed one page's WebGPU device at a time and the check timed out with no
// word about the GPU. scripts/support/device-loss.js's page init script reports every device lost other than by
// destroy(); this runs it against a stand-in WebGPU adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceLossGuard, deviceLossMessage } from '../scripts/support/device-loss.js';

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
