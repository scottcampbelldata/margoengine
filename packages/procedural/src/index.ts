import { Noise } from './noise.js';
export * from './noise.js';
export {
  generateTreeMesh,
  generateShrubMesh,
  generateRockMesh,
  generateFernMesh,
  generateGrassMesh,
  contactAO,
  radialAO,
  type MeshDetail,
  type MeshDetailOptions,
  type RockForm,
  type TreeMeshShapeOptions,
} from './foliage.js';
export {
  generateAcaciaMesh,
  generateBirchMesh,
  generateCactusMesh,
  generatePalmMesh,
  generateReedMesh,
  generateSnagMesh,
  generateTundraShrubMesh,
  type TreeMesh,
} from './plants.js';
export { generateJettyMesh, generateBoatMesh, type JettyOptions, type BoatOptions } from './waterfront.js';
export {
  generateCabinMesh,
  generateLogWall,
  ROOF_PITCH,
  type HeightField,
  type CabinMesh,
  type LogWallOptions,
} from './cabin.js';
export { generateWindowPane, type Glazing, type WindowPane, type WindowPaneOptions } from './glazing.js';
export { createHumanoid, poseHumanoid } from './humanoid.js';
export {
  marchingCubes,
  Metaballs,
  type DensityField,
  type MarchingCubesOptions,
  type Metaball,
  type MetaballsOptions,
} from './marching-cubes.js';
/** Seeded coastal island preset; returns an allocation-free world-height sampler. */
export function createIslandHeight(seed = 731): (x: number, z: number) => number {
  const noise = new Noise(seed);
  return (x, z) => {
    const radius = Math.hypot(x, z);
    const shelf = 5.5 * Math.exp(-((radius / 57) ** 4)) - 3.4;
    const east = 21 * Math.exp(-(((x - 30) / 18) ** 2) - ((z + 25) / 24) ** 2);
    const west = 13 * Math.exp(-(((x + 34) / 19) ** 2) - ((z + 35) / 20) ** 2);
    const ridge = noise.perlin(x * 0.045, 0.3, z * 0.045) * 2.8 + noise.perlin(x * 0.14, 2, z * 0.14) * 0.55;
    return shelf + east + west + ridge * Math.exp(-((radius / 67) ** 4));
  };
}
