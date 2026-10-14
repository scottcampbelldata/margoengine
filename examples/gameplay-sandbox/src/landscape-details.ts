import {PbrMaterial, type EngineKernel} from '@margoengine/core';
import {toGeometry, applyMatrix4, wireframePositions} from '@margoengine/geometry';
import {generateRockMesh, generateGrassMesh} from '@margoengine/procedural';
import {heightfieldGeometry} from '@margoengine/terrain';
import {Scatter, type GroundBounds} from '@margoengine/scatter';
import {Line, Lines} from '@margoengine/lines';
import {terrainHeight, ISLAND_SIZE} from './scene.js';
import {sceneSamples} from '@margoengine/quality';
import {MATERIALS} from './procedural/meshes.ts';
import {CABIN_EXCLUSIONS} from './procedural/placement.ts';

/** Grass placement and the hidden wireframe are secondary to the visible island. */
export function createLandscapeDetails(engine: EngineKernel, exclusions: readonly GroundBounds[], heightmap: () => GPUTexture | undefined) {
  const mobile = sceneSamples() === 1;
  const linePositions = wireframePositions(heightfieldGeometry(terrainHeight,{size: [ISLAND_SIZE,ISLAND_SIZE], resolution: 64}),0.035);
  const lines = Lines.attach(engine);
  const terrainWireframe = lines.add(new Line({positions: linePositions, mode: 'segments', color: '#daf6aa', width: 0.8, opacity: 0.65, visible: false, join: 'miter', cap: 'butt'}));
  const grass = Scatter.attach(engine, [toGeometry(generateGrassMesh(3)),toGeometry(generateGrassMesh(2)),toGeometry(generateGrassMesh(1))], {count: mobile ? 25_000 : 110_000, area: [ISLAND_SIZE, ISLAND_SIZE], minHeight: 0.9, maxHeight: 13, maxSlope: 32, density: 0.86, scale: [0.6, 1.3], lod: [18, 42, 105], material: new PbrMaterial({color: [0.19, 0.28, 0.09], roughness: 0.95, doubleSided: true}), wind: [1,0.35,0.2], seed: 37, exclusions: CABIN_EXCLUSIONS, heightmap});
  const rocks = applyMatrix4(generateRockMesh(),[0.65,0,0,0,0,0.65,0,0,0,0,0.65,0,0,0,0,1]);
  const fieldstones = Scatter.attach(engine, toGeometry(rocks), {count: 950, area: [ISLAND_SIZE, ISLAND_SIZE], minHeight: 0.25, maxSlope: 55, scale: [0.3, 1.6], lod: [24, 55, 130], material: new PbrMaterial(MATERIALS.foundation), seed: 9, exclusions, heightmap});
  return {wireframe: terrainWireframe, grass, fieldstones};
}
