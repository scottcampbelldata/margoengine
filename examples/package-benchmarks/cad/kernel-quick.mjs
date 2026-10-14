// Quick kernel tick check at the max CAD size (Node, same Wasm as the browser): static and 1%-moving ticks.
// Run: node examples/package-benchmarks/cad/kernel-quick.mjs
import {Engine, TransformStore} from '../../../packages/core/dist/extension.js';
import {buildAssembly} from './assembly.js';
const median = v => +v.sort((a, b) => a - b)[v.length >> 1].toFixed(3), fake = {backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {}};
const modules = 3329, capacity = Math.min(100_000, modules * 30 + Math.ceil(modules / 32) + 1);
const e = new Engine({width: 1432, height: 768, clientWidth: 1432, clientHeight: 768}, await TransformStore.create(capacity), fake, {position: [10, 8, 12], target: [0, 0, 0]}, null);
const {parts} = buildAssembly(e, modules);e.render();
const run = (fn, n = 60) => {for (let i = 0; i < 10; i++) fn(i);const t = [];for (let i = 0; i < n; i++) {const s = performance.now();fn(i);t.push(performance.now() - s);}return median(t);};
const movers = parts.filter((_, i) => i % 100 === 0);
console.log(JSON.stringify({entities: e.meshes.size, staticTickMs: run(() => e.store.tick(true)), movingTickMs: run(i => {for (const p of movers) p.position.y = i * 1e-4;e.store.tick(true);}), renderStaticMs: run(() => e.render()), renderMovingMs: run(i => {for (const p of movers) p.position.y = i * 1e-4;e.render();})}));
e.dispose();
