import { SETTINGS } from './scene.mjs';

export const assetCommit = '8f492390ddc7a2ae221a1369ef560589cf8c70fb';
export const cases = {
  'metallic-roughness': {
    model: 'MetalRoughSpheresNoTextures',
    settings: SETTINGS,
    scale: 1000,
    sourceSha256: '5e677f260ec0f366967a6e9545de2f3dab2a160e307b9bcb9d050cd2028f63f8',
  },
  clearcoat: {
    model: 'ClearCoatTest',
    license: 'CC-BY-4.0, Analytical Graphics, Inc., Ed Mackey, 2020',
    sourceSha256: 'c3a1cbe318cd043b937130af4eb83ec2ea0b03613387b1b7d769dfab4ac15948',
    scale: 1,
    settings: {
      ...SETTINGS,
      camera: { position: [-1.5, 0.3, 25], target: [-1.5, 0.3, 0], fov: 35, near: 0.1, far: 100 },
    },
  },
};

export function referenceCase(name) {
  const result = cases[name];
  if (!result) throw new Error(`Unknown reference case: ${name}`);
  return result;
}
