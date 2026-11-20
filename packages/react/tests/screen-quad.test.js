import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode, createRef } from 'react';
import { JSDOM } from 'jsdom';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

// ScreenQuad on the real RawShaders, shaderMesh and GLSL ShaderMaterial of @margoengine/shader on a core engine; only
// the GPU device is a stand-in.
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { render, act, cleanup } = await import('@testing-library/react');
const { Engine, TransformStore } = await import('@margoengine/core/extension');
const { Context } = await import('../dist/internal.js');
const { ScreenQuad } = await import('../dist/effects-extra.js');
const { ShaderMaterial } = await import('@margoengine/shader/glsl-material');
const h = React.createElement,
  engines = [];
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));
afterEach(async () => {
  cleanup();
  await act(async () => {});
  for (const engine of engines.splice(0)) engine.dispose();
});
const fragmentShader = `precision highp float;
uniform float time;
varying vec2 vUv;
void main() { gl_FragColor = vec4(vUv, sin(time), 1.0); }`;
async function context() {
  const gpu = optionalGPU(),
    engine = new Engine(
      { width: 64, height: 64 },
      await TransformStore.create(64),
      { backend: 'webgpu', gpu: gpu.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    ),
    errors = [];
  engines.push(engine);
  engine.onError = (error) => errors.push(error);
  const scene = {
    engine,
    world: null,
    registry: null,
    pointerHandlers: new Map(),
    frames: { callbacks: new Set() },
    resources: { models: new Set(), lighting: new Map() },
    shadows: null,
  };
  const raws = () =>
    [...engine.scene.plugins.values()].filter((plugin) => plugin.name.startsWith('margoengine-react:screen-quad'));
  return { engine, errors, raws, tree: (child) => h(StrictMode, null, h(Context.Provider, { value: scene }, child)) };
}

test('ScreenQuad draws one never-culled full-screen triangle with a material built from its fragment shader', async () => {
  const { errors, raws, tree } = await context(),
    ref = createRef();
  const quad = (time, order = 0) =>
    tree(h(ScreenQuad, { ref, fragmentShader, uniforms: { time: { value: time } }, renderOrder: order }));
  const view = render(quad(0.5));
  await settle();
  assert.deepEqual(errors, []);
  assert.equal(raws().length, 1, 'one RawShaders for the scene');
  const mesh = ref.current;
  assert.ok(mesh, 'the ref is the RawMesh');
  assert.equal(mesh.frustumCulled, false);
  assert.ok(mesh.material instanceof ShaderMaterial);
  assert.equal(mesh.material.uniforms.time.value, 0.5);
  const position = mesh.material.program.attributes.find((a) => a.name === 'position');
  assert.ok(position, 'the default vertex stage reads position');
  view.rerender(quad(2, 3));
  await settle();
  assert.equal(ref.current, mesh, 'a uniform or order change keeps the mesh and material');
  assert.equal(mesh.material.uniforms.time.value, 2, 'uniform values are copied in');
  assert.equal(mesh.renderOrder, 3);
  mesh.material.uniforms.time.value = 7;
  view.rerender(quad(2, 4));
  await settle();
  assert.equal(mesh.material.uniforms.time.value, 7, 'an unchanged prop does not put back a live-advanced value');
  view.unmount();
  await settle();
  assert.equal(raws().length, 0, 'the last ScreenQuad removes the plugin');
});

test('ScreenQuad shares the plugin, keeps a supplied material, and reports a missing shader', async () => {
  const { errors, raws, tree } = await context(),
    a = createRef(),
    b = createRef(),
    failures = [];
  const material = new ShaderMaterial({
    vertexShader: 'attribute vec3 position; void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: 'precision highp float; void main() { gl_FragColor = vec4(1.0); }',
  });
  const view = render(
    tree(h(React.Fragment, null, h(ScreenQuad, { ref: a, material }), h(ScreenQuad, { ref: b, fragmentShader }))),
  );
  await settle();
  assert.deepEqual(errors, []);
  assert.equal(raws().length, 1, 'both quads share one plugin');
  assert.equal(a.current.material, material);
  view.unmount();
  await settle();
  assert.equal(material.uniforms !== undefined, true, 'the supplied material is left to its owner');
  render(tree(h(ScreenQuad, { onError: (error) => failures.push(error) })));
  await settle();
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /needs a material or a fragmentShader/);
});
