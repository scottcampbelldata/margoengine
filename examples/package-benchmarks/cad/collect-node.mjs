// Full batch collection cost at the max CAD size (Node, fake renderer): frames forced to re-collect, as when the
// cull result changes every frame during an orbit. Run: node examples/package-benchmarks/cad/collect-node.mjs
import {Engine, TransformStore} from '../../../packages/core/dist/extension.js';
import {buildAssembly} from './assembly.js';
const fake = {backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {}}, modules = 3329;
const e = new Engine({width: 1432, height: 768, clientWidth: 1432, clientHeight: 768}, await TransformStore.create(Math.min(100_000, modules * 30 + Math.ceil(modules / 32) + 1)), fake, {position: [10, 8, 12], target: [0, 0, 0]}, null);
buildAssembly(e, modules);e.render();
const median = v => +v.sort((a, b) => a - b)[v.length >> 1].toFixed(3);
const run = fn => {for (let i = 0; i < 20; i++) fn();const t = [];for (let i = 0; i < 60; i++) {const s = performance.now();fn();t.push(performance.now() - s);}return median(t);};
const tick = run(() => e.store.tick(true)), full = run(() => {e.collected = -1;e.render();}), reuse = run(() => e.render());
console.log(JSON.stringify({visible: e.stats.visible, tickMs: tick, fullFrameMs: full, reusedFrameMs: reuse, collectMs: +(full - reuse).toFixed(3)}));
e.dispose();
