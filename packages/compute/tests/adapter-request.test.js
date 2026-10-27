import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompute } from '@margoengine/compute';

// createCompute passes powerPreference to requestAdapter except on Windows, where browsers ignore it and log a console
// warning. An explicit powerPreference is always passed. The fake adapter request returns null, so the context falls back
// to the CPU and the test sees only the request.

const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36';
const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36';

test('createCompute sends the default powerPreference only where the browser honours it', async (t) => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  t.after(() => (saved ? Object.defineProperty(globalThis, 'navigator', saved) : delete globalThis.navigator));
  const table = [
    ['Windows', WINDOWS, undefined, {}],
    ['macOS', MAC, undefined, { powerPreference: 'high-performance' }],
    ['Linux', LINUX, undefined, { powerPreference: 'high-performance' }],
    ['Windows, explicit', WINDOWS, 'low-power', { powerPreference: 'low-power' }],
    ['macOS, explicit', MAC, 'low-power', { powerPreference: 'low-power' }],
  ];
  for (const [name, userAgent, powerPreference, expected] of table) {
    const asked = [];
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent, gpu: { requestAdapter: async (options) => (asked.push(options), null) } },
    });
    const compute = await createCompute({ backend: 'auto', powerPreference });
    compute[Symbol.dispose]?.();
    assert.deepEqual(asked, [expected], name);
  }
});
