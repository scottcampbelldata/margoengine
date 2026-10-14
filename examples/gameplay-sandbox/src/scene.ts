import {PbrMaterial, type EngineKernel} from '@margoengine/core';
import {toGeometry} from '@margoengine/geometry';
import {createIslandHeight, createHumanoid} from '@margoengine/procedural';
import {TerrainColors, TerrainHeightmap, heightfieldGeometry} from '@margoengine/terrain';
import type {Shadows} from '@margoengine/shadows';
import {sceneSamples} from '../../../packages/shared/quality.js';
export const ISLAND_SIZE = 160;
export const terrainHeight = createIslandHeight(731);

export function createLandscape(engine: EngineKernel, shadows: Shadows, wetDepth?: () => GPUTexture | undefined) {
  const mobile = sceneSamples() === 1;
  const data = heightfieldGeometry(terrainHeight,{size: [ISLAND_SIZE,ISLAND_SIZE], resolution: mobile ? 96 : 192});
  const mesh = engine.createMesh().setGeometry(toGeometry(data)).setMaterial(new PbrMaterial({color: '#536b49', roughness: 0.95}));
  mesh.name = 'Island terrain'; shadows.add(mesh, {static: true});
  TerrainColors.attach(engine,mesh,{sand: [0.44,0.36,0.23], meadow: [[0.10,0.18,0.055],[0.19,0.26,0.09]], stone: [0.28,0.30,0.23], shore: [0.4,1.7], meadowHeight: [3,12], stoneHeight: [13,20], stoneNormal: [0.58,0.85], wetHeight: [0,0.65], wetDarkening: 0.55, variation: 0.06, wetness: wetDepth ? {texture: wetDepth, origin: [-80,-80], size: [ISLAND_SIZE,ISLAND_SIZE]} : undefined});
  const map = TerrainHeightmap.attach(engine,terrainHeight,{size: [ISLAND_SIZE,ISLAND_SIZE], resolution: mobile ? 128 : 256}), heightmap = () => map.texture;
  return {mesh, heightmap};
}

export function createCharacter(engine: EngineKernel, shadows: Shadows) {
  const rig = createHumanoid(engine,[new PbrMaterial({color: '#d9e3d3', roughness: 0.38}),new PbrMaterial({color: '#344b48', roughness: 0.65}),new PbrMaterial({color: '#dae49a', metalness: 0.5, roughness: 0.15})]);
  rig.root.name = 'Offline explorer rig';
  for (const part of rig.parts) shadows.add(part);
  return rig;
}
