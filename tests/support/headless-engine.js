// A real Engine and TransformStore with a no-op renderer, so the Mesh API and the Wasm kernel run in Node. Shared by
// the package tests that build meshes without a GPU (exporters, ifc); packages/exporters/tests/helpers.js re-exports it.
import { Engine, TransformStore } from '@margoengine/core/extension';

/** A headless engine with room for `capacity` transforms. */
export async function headlessEngine(capacity = 256) {
  const store = await TransformStore.create(capacity);
  const renderer = { backend: 'webgl2', add() {}, remove() {}, dispose() {}, render() {} };
  return new Engine({ width: 1, height: 1, getContext() {} }, store, renderer, undefined, null);
}
