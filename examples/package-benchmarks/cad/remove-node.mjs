// Mesh removal cost at the max CAD size (Node, fake renderer): one leaf, 1,000 leaves, groups, then engine.dispose().
// Run: node examples/package-benchmarks/cad/remove-node.mjs
import {Engine, TransformStore} from '../../../packages/core/dist/extension.js';
import {buildAssembly} from './assembly.js';
import {requireAC} from './power.mjs';
const acPowerAtStart = requireAC(), fake = {backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {}}, modules = 3329;
const e = new Engine({width: 1432, height: 768, clientWidth: 1432, clientHeight: 768}, await TransformStore.create(Math.min(100_000, modules * 30 + Math.ceil(modules / 32) + 1)), fake, {position: [10, 8, 12], target: [0, 0, 0]}, null);
const {parts, groups} = buildAssembly(e, modules);e.render();
const time = fn => {const s = performance.now();fn();return +(performance.now() - s).toFixed(3);};
const result = {entities: e.meshes.size, oneLeafMs: time(() => parts.pop().dispose()), thousandLeavesMs: time(() => {for (let i = 0; i < 1000; i++) parts.pop().dispose();})};
const sets = groups.filter(g => g.name === 'fasteners').slice(0, 100);result.hundredGroupsMs = time(() => {for (const g of sets) g.dispose();});
e.render();result.engineDisposeMs = time(() => e.dispose());result.acPowerAtStart = acPowerAtStart;result.acPowerAtEnd = requireAC();
console.log(JSON.stringify(result));
