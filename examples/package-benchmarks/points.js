import {PointsPlugin, PointCloud, SpriteBatch, multiply, projectPoint} from '../../packages/points/dist/index.js';
import {fetchBytes, parsePCD} from '../../packages/loaders/dist/index.js';
import {controls} from './ui-scene.js';

export async function createWorkload(count = 4, options = {}) {
  if (!Number.isInteger(count) || count < 1 || count > 9) throw new RangeError('Point workload cloud count must be 1..9');
  const source = await fetchBytes(new URL('../../packages/loaders/tests/fixtures/bunny.pcd', import.meta.url), {...options, maxBytes: 100000}), loaded = parsePCD(source), base = loaded.positions.slice(), min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < base.length; i++) {const axis = i % 3; min[axis] = Math.min(min[axis], base[i]); max[axis] = Math.max(max[axis], base[i]);}
  const extent = Math.max(...max.map((value, axis) => value - min[axis]));
  for (let i = 0; i < base.length; i++) {const axis = i % 3; base[i] = (base[i] - (min[axis] + max[axis]) / 2) * 1.8 / extent;}
  let clouds = Array.from({length: count}, (_, index) => new PointCloud({positions: base.slice(), blockSize: 64, seed: index + 1, material: {size: 4, shape: 'round', shading: 'sphere', color: ['#82d9ba', '#e6bb79', '#a8a3e6'][index % 3]}}));
  const points = new Float32Array(count * 4), yaw = new Float32Array(count), range = new Float32Array(32 * 3), side = Math.ceil(Math.sqrt(count)), edge = side * 1.2;
  let plugin, sprites, ui, engine, time = 0, frames = 0, positionUpdates = 0, disposed = false, edl = false, lastPickedIndex = null;
  const step = delta => {
    if (disposed) return; if (!Number.isFinite(delta) || delta < 0 || delta > 0.1) throw new RangeError('Invalid points frame delta'); time += delta; frames++;
    for (let i = 0; i < count; i++) {
      points[i * 4] = (i % side - (side - 1) / 2) * 2.4; points[i * 4 + 1] = 1.1; points[i * 4 + 2] = (Math.floor(i / side) - (side - 1) / 2) * 2.4; points[i * 4 + 3] = i % 3; yaw[i] = time * 0.15;
      for (let j = 0; j < range.length; j++) range[j] = base[j] + (j % 3 === 1 ? Math.sin(time * 2 + i + Math.floor(j / 3) * 0.15) * 0.03 : 0);
      clouds[i].updatePositions(0, range); positionUpdates++;
      if (sprites) {const offset = i * 16; sprites.data[offset] = points[i * 4]; sprites.data[offset + 1] = 2.05; sprites.data[offset + 2] = points[i * 4 + 2]; sprites.data[offset + 3] = time; sprites.markDirty(i, 1);}
    }
  };
  step(0);
  return {points, yaw, get clouds() {return clouds;}, bounds: {min: [-edge, 0, -edge], max: [edge, 2.3, edge]},
    description: 'Real Stanford bunny PCD clouds are drawn by PointsPlugin, with 32-point range updates per cloud every frame and an actual SpriteBatch of rotating cloud markers. The small core cubes are cloud anchors. Input/drawn counts and actual upload bytes are separate; toggle eye-dome lighting or click drawn points to pick.', step,
    mount(context) {
      if (disposed) throw new Error('Point workload is disposed');
      if (context.engine.backend !== 'webgpu') throw new Error('Points benchmark requires WebGPU; no cloud FPS is reported without real point draws');
      engine = context.engine;
      plugin = new PointsPlugin({pointBudget: clouds.length * clouds[0].count}); context.engine.use(plugin);
      clouds.forEach((cloud, index) => plugin.add(cloud.attach(context.meshes[index])));
      sprites = plugin.add(new SpriteBatch({capacity: count, material: {color: '#e6bb79', transparent: true}}));
      for (let i = 0; i < count; i++) sprites.add({position: [points[i * 4], 2.05, points[i * 4 + 2]], size: 0.14});
      ui = controls(context.parent, count, index => {clouds[index].material.setColor('#e9908c'); context.render();});
      ui.button('Toggle eye-dome lighting', () => {edl = !edl; clouds.forEach(cloud => {cloud.material.edl = edl;}); context.render();}).dataset.uiEdl = '';
      ui.listen(context.engine.canvas, 'click', event => {const rect = context.engine.canvas.getBoundingClientRect(); lastPickedIndex = plugin.pick(event.clientX - rect.left, event.clientY - rect.top, {radius: 8})?.index ?? null;});
    },
    interaction() {
      if (!plugin || !clouds[0]?.attachedMesh) return null;
      const cloud = clouds[0], matrix = multiply(engine.camera.matrix, cloud.attachedMesh.matrix), pixel = new Float64Array(3), canvas = engine.canvas;
      for (let i = 0; i < cloud.positions.length; i += 3) if (projectPoint(matrix, ...cloud.positions.subarray(i, i + 3), canvas.clientWidth, canvas.clientHeight, pixel) && pixel[0] >= 0 && pixel[0] < canvas.clientWidth && pixel[1] >= 0 && pixel[1] < canvas.clientHeight && plugin.pick(pixel[0], pixel[1], {radius: 8})) return {pointX: pixel[0], pointY: pixel[1]};
      return null;
    },
    details: () => ({clouds: count, inputPoints: count * base.length / 3, pointsPerCloud: base.length / 3, updatedPointsPerFrame: count * 32, frames, positionUpdates, pointDraws: plugin?.stats.pointsDrawn ?? 0, pointDrawCalls: plugin?.stats.drawCalls ?? 0, uploadBytes: plugin?.stats.uploadBytes ?? 0, sprites: sprites?.count ?? 0, edl, lastPickedIndex}),
    dispose() {if (disposed) return; disposed = true; clouds.forEach(cloud => {cloud.attach(null); cloud.dispose();}); sprites?.dispose(); if (plugin) engine?.removePlugin(plugin.name); ui?.dispose(); clouds = [];}
  };
}
