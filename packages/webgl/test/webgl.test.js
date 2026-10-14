import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../../core/dist/engine.js';
import {webglRenderer, GLRenderer} from '../dist/index.js';

test('core uses the WebGL fallback only when an app passes it', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), calls = [];
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {userAgent: 'Windows NT'}});
  try {
    const canvas = {width: 4, height: 4, clientWidth: 4, clientHeight: 4, getContext: () => null};
    await assert.rejects(Engine.create(canvas, {backend: 'auto'}), /WebGPU unavailable|adapter unavailable/);
    await assert.rejects(Engine.create(canvas, {backend: 'webgl2'}), /WebGPU unavailable/);
    const fallback = target => {calls.push(target); return {backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {}};};
    const engine = await Engine.create(canvas, {backend: 'auto', fallback});
    assert.equal(engine.backend, 'webgl2'); assert.deepEqual(calls, [canvas]); engine.dispose();
    assert.throws(() => webglRenderer({getContext: () => null}), /No WebGL2/);
    assert.throws(() => new GLRenderer({getContext: () => null}), /No WebGL2/);
  } finally {if (saved) Object.defineProperty(globalThis, 'navigator', saved); else delete globalThis.navigator;}
});
