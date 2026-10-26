import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Material, materialShader, nodeMaterial, transmission } from '../dist/index.js';
import { Transmission } from '../dist/transmission.js';

// Every throw names the fix and uses a coded or typed error, never a bare Error.
test('shader patching failures are coded MargoErrors that name the fix', () => {
  assert.throws(() => materialShader('fn other(){}', 2, 'standard'), {
    name: 'MargoError',
    code: 'state',
    message: /standard gltf-pro PBR shader; update @margoengine\/gltf-pro/,
  });
});

test('volume without transmission is a coded state error', () => {
  assert.throws(() => transmission({ factor: 0, volume: { thicknessFactor: 1 }, opaqueColor: {} }), {
    name: 'MargoError',
    code: 'state',
    message: /set a transmission factor above 0/,
  });
});

test('transmission passes report unattached and disposed use with codes', () => {
  const pass = new Transmission();
  assert.throws(() => pass.add({}), { name: 'MargoError', code: 'state', message: /attach\(engine\) first/ });
  pass[Symbol.dispose]();
  assert.throws(() => pass.add({}), { name: 'MargoError', code: 'disposed', message: /create a new Transmission/ });
});

test('node graph shape errors are TypeErrors that say what to change', () => {
  const color = { type: 'color', value: [1, 1, 1, 1] },
    emit = { type: 'emit', color };
  assert.throws(() => nodeMaterial({ nodes: [emit, { ...emit }] }), {
    name: 'TypeError',
    message: /exactly one emit; keep one emit node/,
  });
});

test('material argument errors name the argument and the fix', () => {
  assert.throws(() => Object.assign(new Material(), { side: 'x' }), {
    name: 'TypeError',
    message: /side; use 'front', 'back' or 'double'/,
  });
  assert.throws(() => Object.assign(new Material(), { depthPacking: 'x' }), {
    name: 'TypeError',
    message: /depthPacking; use 'basic' or 'rgba'/,
  });
  assert.throws(() => new Material({ roughness: 2 }), {
    name: 'RangeError',
    message: /must be in \[0, 1\]; set a number from 0 to 1/,
  });
});
