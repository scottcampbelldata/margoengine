import { Physics } from '../../dist/index.js';
import { CellMaterial, SoftBodies, SoftBodyDesc } from '../../dist/soft.js';

export const step = 1 / 60;
export const length = 0.125;
export const volume = length ** 3 / 6;
export const materials = {
  muscle: Object.assign(new CellMaterial(), { density: 1060, youngsModulus: 6000, poissonRatio: 0 }),
  fat: Object.assign(new CellMaterial(), { density: 900, youngsModulus: 2500, poissonRatio: 0 }),
  skin: Object.assign(new CellMaterial(), { density: 1120, youngsModulus: 18000, poissonRatio: 0 }),
};
export const cells = ['muscle', 'fat', 'skin'];
export async function createLayerFixture() {
  const physics = new Physics(null, { gravity: [0, 0, 0], fixedTimestep: step });
  const soft = await SoftBodies.attach(physics, { substeps: 1, iterations: 3 });
  soft.cellDamping = 0;
  const desc = new SoftBodyDesc([
    [0, 0, 0],
    [length, 0, 0],
    [0, length, 0],
    [-length, 0, 0],
    [0, -length, 0],
    [0, 0, length],
  ])
    .setCells([0, 1, 2, 5, 0, 2, 3, 5, 0, 3, 4, 5])
    .setSurface()
    .setSolver('vertex-block')
    .setParticleRadius(0)
    .setLinearDamping(0)
    .setPinnedParticles([0, 1, 2, 3, 4]);
  return { physics, soft, desc };
}
