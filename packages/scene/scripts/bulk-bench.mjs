// Setters against TransformWriter, in Node, CPU only. Build first: npm run build --workspace packages/scene
// Usage: node packages/scene/scripts/bulk-bench.mjs [meshes]
import { Engine, TransformStore } from '@margoengine/core/extension';
import { TransformWriter } from '../dist/bulk.js';

const renderer = () => ({ backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} });
const count = Number(process.argv[2] ?? 10000);
const engine = new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, await TransformStore.create(count + 1), renderer());
const meshes = Array.from({ length: count }, () => engine.createMesh());
const positions = new Float32Array(count * 3).map((_, i) => Math.sin(i)),
  quaternions = new Float32Array(count * 4).map((_, i) => Math.cos(i * 1.3) + 0.1),
  rotations = new Float32Array(count * 3).map((_, i) => Math.sin(i * 0.7));
const writer = new TransformWriter(meshes);
const row = [0, 0, 0, 0];
const cases = {
  'setter position': () => {
    for (let i = 0; i < count; i++) meshes[i].position.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
  },
  'bulk position': () => writer.write({ positions }),
  'setter position+quaternion': () => {
    for (let i = 0; i < count; i++) {
      meshes[i].position.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      row[0] = quaternions[i * 4];
      row[1] = quaternions[i * 4 + 1];
      row[2] = quaternions[i * 4 + 2];
      row[3] = quaternions[i * 4 + 3];
      meshes[i].setQuaternion(row);
    }
  },
  'bulk position+quaternion': () => writer.write({ positions, quaternions }),
  'setter position+euler': () => {
    for (let i = 0; i < count; i++) {
      meshes[i].position.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      meshes[i].rotation.set(rotations[i * 3], rotations[i * 3 + 1], rotations[i * 3 + 2]);
    }
  },
  'bulk position+euler': () => writer.write({ positions, rotations }),
};
for (let round = 0; round < 2; round++)
  for (const [name, run] of Object.entries(cases)) {
    for (let i = 0; i < 300; i++) run();
    const times = [];
    for (let i = 0; i < 300; i++) {
      const t = performance.now();
      run();
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    if (round) console.log(name.padEnd(30), times[150].toFixed(3), 'ms median at', count);
  }
