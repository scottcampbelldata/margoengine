// Helpers for suites that run in Node (the same Wasm kernel and package code as the browser, no GPU).
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

/** Median of an array (sorted copy). */
export const median = (values) => {
  const v = [...values].sort((a, b) => a - b);
  return v.length % 2 ? v[v.length >> 1] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
};

/** Median ms of `fn()` over `reps` calls after `warm` untimed calls. One run's sample for a node case. */
export function timed(fn, { reps = 30, warm = 3 } = {}) {
  for (let i = 0; i < warm; i++) fn();
  const t = [];
  for (let i = 0; i < reps; i++) {
    const s = performance.now();
    fn();
    t.push(performance.now() - s);
  }
  return median(t);
}

/** The async form of timed(). */
export async function timedAsync(fn, { reps = 10, warm = 1 } = {}) {
  for (let i = 0; i < warm; i++) await fn();
  const t = [];
  for (let i = 0; i < reps; i++) {
    const s = performance.now();
    await fn();
    t.push(performance.now() - s);
  }
  return median(t);
}

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc');
/** JS heap and ArrayBuffer memory (the Wasm kernel's memory among them) after two full collections, in MB. */
export function memoryMB() {
  gc();
  gc();
  const { heapUsed, arrayBuffers } = process.memoryUsage();
  return { heap: heapUsed / 2 ** 20, buffers: arrayBuffers / 2 ** 20 };
}

const canvas = { width: 1280, height: 720, clientWidth: 1280, clientHeight: 720 },
  backend = { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} };
/** A core Engine with a renderer that draws nothing: the kernel, scene graph and packages run as in a browser. */
export async function headlessEngine(capacity, camera = { position: [10, 8, 12], target: [0, 0, 0] }) {
  const { Engine, TransformStore } = await import('../../packages/core/dist/extension.js');
  return new Engine(canvas, await TransformStore.create(capacity), backend, camera, null);
}

/** A node case: `run()` returns this run's metric values. */
export const nodeCase = (id, title, metrics, run, extra = {}) => ({
  id,
  title,
  metrics,
  async run() {
    return { values: await run() };
  },
  ...extra,
});

export const ms = (primary = true) => ({ unit: 'ms', better: 'lower', primary });
