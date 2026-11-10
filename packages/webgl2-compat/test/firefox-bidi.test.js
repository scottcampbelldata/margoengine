import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bounded, decode, logEvent } from './support/firefox-bidi.mjs';
import { maskTier } from './support/mask-tier.js';
import { openNativeOracle } from './support/native-oracle.mjs';

test('Firefox CSP diagnostics remain visible console errors while uncaught exceptions are page errors', () => {
  const [kind, message] = logEvent({
    type: 'javascript',
    level: 'error',
    text: 'Content-Security-Policy: blocked unsafe-eval',
  });
  assert.equal(kind, 'console');
  assert.equal(message.type(), 'error');
  assert.match(message.text(), /unsafe-eval/);
  const [errorKind, error] = logEvent({ type: 'javascript', level: 'error', text: 'Uncaught Error: broken shader' });
  assert.equal(errorKind, 'pageerror');
  assert.match(error.message, /broken shader/);
});

test('the Firefox executable override never reaches a Chromium oracle and is restored after either outcome', async () => {
  const previous = process.env.BROWSER_EXECUTABLE;
  process.env.BROWSER_EXECUTABLE = 'firefox-from-environment';
  try {
    const options = {};
    assert.equal(
      await openNativeOracle(options, async (value) => {
        assert.equal(value, options);
        assert.equal(process.env.BROWSER_EXECUTABLE, undefined);
        return 'oracle';
      }),
      'oracle',
    );
    assert.equal(process.env.BROWSER_EXECUTABLE, 'firefox-from-environment');
    await assert.rejects(
      openNativeOracle(options, async () => {
        assert.equal(process.env.BROWSER_EXECUTABLE, undefined);
        throw new Error('native failure');
      }),
      /native failure/,
    );
    assert.equal(process.env.BROWSER_EXECUTABLE, 'firefox-from-environment');
  } finally {
    if (previous === undefined) delete process.env.BROWSER_EXECUTABLE;
    else process.env.BROWSER_EXECUTABLE = previous;
  }
});

test('forced half-float keeps the 16F guarantee of the full extension without requiring the older extension', () => {
  for (const tier of ['full', 'half-float', 'ldr']) {
    const gl = maskTier({ getExtension: (name) => (name === 'EXT_color_buffer_float' ? {} : null) }, tier);
    assert.equal(!!gl.getExtension('EXT_color_buffer_float'), tier === 'full');
    assert.equal(!!gl.getExtension('EXT_color_buffer_half_float'), tier !== 'ldr');
    assert.equal(gl.getExtension('unknown'), null);
  }
  assert.equal(
    maskTier({ getExtension: () => null }, 'half-float').getExtension('EXT_color_buffer_half_float'),
    null,
    'a physical LDR device never gains an unsupported capability',
  );
});

test('BiDi data preserves nested values and special floating-point results', () => {
  const value = decode({
    type: 'object',
    value: [
      [
        'data',
        {
          type: 'array',
          value: [
            { type: 'number', value: 'NaN' },
            { type: 'number', value: '-0' },
            { type: 'number', value: 'Infinity' },
            { type: 'number', value: '-Infinity' },
            { type: 'undefined' },
            { type: 'null' },
            { type: 'boolean', value: true },
            { type: 'string', value: 'test' },
          ],
        },
      ],
    ],
  });
  assert.deepEqual(value, { data: [NaN, -0, Infinity, -Infinity, undefined, null, true, 'test'] });
  assert.throws(() => decode({ type: 'node' }), /Unsupported BiDi result type/);
});

test('BiDi commands have a hard bound and preserve the original rejection', async () => {
  assert.equal(await bounded(Promise.resolve(42), 1000, 'command'), 42);
  const error = new Error('original');
  await assert.rejects(bounded(Promise.reject(error), 1000, 'command'), (candidate) => candidate === error);
  await assert.rejects(bounded(new Promise(() => {}), 1, 'command'), /command exceeded 1 ms/);
});
