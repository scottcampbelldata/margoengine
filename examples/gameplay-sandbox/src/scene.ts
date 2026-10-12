import {PbrMaterial, type EngineKernel} from '@margoengine/core';
import {toGeometry, applyMatrix4, wireframePositions} from '@margoengine/geometry';
import {createIslandHeight, generateRockMesh, generateGrassMesh, createHumanoid} from '@margoengine/procedural';
import {TerrainColors, TerrainHeightmap, heightfieldGeometry} from '@margoengine/terrain';
import {Scatter, type GroundBounds} from '@margoengine/scatter';
import {Line, Lines} from '@margoengine/lines';
import type {Shadows} from '@margoengine/shadows';
import {MATERIALS} from './procedural/meshes.ts';
import {CABIN_EXCLUSIONS} from './procedural/placement.ts';
export const ISLAND_SIZE = 160;
export const terrainHeight = createIslandHeight(731);

export function createLandscape(engine: EngineKernel, shadows: Shadows, exclusions: readonly GroundBounds[], wetDepth?: () => GPUTexture | undefined) {
  const data = heightfieldGeometry(terrainHeight,{size: [ISLAND_SIZE,ISLAND_SIZE], resolution: 192});
  const mesh = engine.createMesh().setGeometry(toGeometry(data)).setMaterial(new PbrMaterial({color: '#536b49', roughness: 0.95}));
  mesh.name = 'Island terrain'; shadows.add(mesh, {static: true});
  TerrainColors.attach(engine,mesh,{sand: [0.44,0.36,0.23], meadow: [[0.10,0.18,0.055],[0.19,0.26,0.09]], stone: [0.28,0.30,0.23], shore: [0.4,1.7], meadowHeight: [3,12], stoneHeight: [13,20], stoneNormal: [0.58,0.85], wetHeight: [0,0.65], wetDarkening: 0.55, variation: 0.06, wetness: wetDepth ? {texture: wetDepth, origin: [-80,-80], size: [ISLAND_SIZE,ISLAND_SIZE]} : undefined});
  const linePositions = wireframePositions(heightfieldGeometry(terrainHeight,{size: [ISLAND_SIZE,ISLAND_SIZE], resolution: 64}),0.035);
  const lines = new Lines(); engine.use(lines);
  const terrainWireframe = lines.add(new Line({positions: linePositions, mode: 'segments', color: '#daf6aa', width: 0.8, opacity: 0.65, visible: false, join: 'miter', cap: 'butt'}));
  const map = TerrainHeightmap.attach(engine,terrainHeight,{size: [ISLAND_SIZE,ISLAND_SIZE], resolution: 256}), heightmap = () => map.texture;
  Scatter.attach(engine, [toGeometry(generateGrassMesh(3)),toGeometry(generateGrassMesh(2)),toGeometry(generateGrassMesh(1))], {count: 110_000, area: [ISLAND_SIZE, ISLAND_SIZE], minHeight: 0.9, maxHeight: 13, maxSlope: 32, density: 0.86, scale: [0.6, 1.3], lod: [18, 42, 105], material: new PbrMaterial({color: [0.19, 0.28, 0.09], roughness: 0.95, doubleSided: true}), wind: [1,0.35,0.2], seed: 37, exclusions: CABIN_EXCLUSIONS, heightmap});
  const rocks = applyMatrix4(generateRockMesh(),[0.65,0,0,0,0,0.65,0,0,0,0,0.65,0,0,0,0,1]);
  Scatter.attach(engine, toGeometry(rocks), {count: 950, area: [ISLAND_SIZE, ISLAND_SIZE], minHeight: 0.25, maxSlope: 55, scale: [0.3, 1.6], lod: [24, 55, 130], material: new PbrMaterial(MATERIALS.foundation), seed: 9, exclusions, heightmap});
  return {wireframe: terrainWireframe, heightmap};
}

export function createCharacter(engine: EngineKernel, shadows: Shadows) {
  const rig = createHumanoid(engine,[new PbrMaterial({color: '#d9e3d3', roughness: 0.38}),new PbrMaterial({color: '#344b48', roughness: 0.65}),new PbrMaterial({color: '#dae49a', metalness: 0.5, roughness: 0.15})]);
  rig.root.name = 'Offline explorer rig';
  for (const part of rig.parts) shadows.add(part);
  return rig;
}
