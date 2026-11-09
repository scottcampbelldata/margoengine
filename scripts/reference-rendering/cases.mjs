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
  sheen: {
    model: 'SheenTestGrid',
    license: 'CC0-1.0, Eric Chadwick, 2023',
    sourceSha256: 'b3d82dde0ae6b93bef1a8085ec05540b21139f9917bfe771135c5aed9ba1c101',
    scale: 1,
    settings: {
      ...SETTINGS,
      camera: { position: [-0.18, 0, 1.8], target: [-0.18, 0, 0], fov: 35, near: 0.01, far: 100 },
    },
  },
  anisotropy: {
    model: 'AnisotropyStrengthTest',
    license: 'CC0-1.0, Ed Mackey, 2023',
    sourceSha256: '306321ff8214727b145188ceb56d96d2882b393d0b596fa089fd20b07e959834',
    scale: 1,
    settings: { ...SETTINGS, camera: { position: [0, 3, 15], target: [0, 3, 0], fov: 35, near: 0.01, far: 100 } },
  },
  iridescence: {
    model: 'IridescenceMetallicSpheres',
    license: 'CC0-1.0, UX3D, 2022',
    sourceSha256: '2a590ca0724fab992f1bdb189ea59098d6cc3e308aba5cab566c25a1ae5fd895',
    sourceFiles: {
      'glTF/IridescenceMetallicSpheres.gltf': '8b43928584db4a27806fb9b806ebd22d5cb106b2262fc4ce3f4421419c0e60fe',
      'glTF/IridescenceMetallicSpheres.bin': 'eeacab254dfd44b8e026a8ad9e865aa1b63711eb86fa7c36180a437845e97253',
      'glTF/textures/guides.png': '04be7e96eacef9981b3cdf67eeef390d080f601af86d86bef51993ee1bf738cc',
    },
    scale: 1,
    settings: { ...SETTINGS, camera: { position: [42, 32, 53], target: [0, 0, 0], fov: 35, near: 0.01, far: 200 } },
  },
  transmission: {
    model: 'TransmissionTest',
    license: 'CC0-1.0, Adobe, 2020',
    sourceSha256: 'dd9732dae5517f8605ad4324d78b077b969c3e8357c056280d0a4e4b67797d15',
    scale: 1,
    settings: {
      ...SETTINGS,
      camera: { position: [-0.075, 0.11, 4.4], target: [-0.075, 0.11, 0.4], fov: 35, near: 0.01, far: 100 },
    },
  },
  volume: {
    model: 'AttenuationTest',
    license: 'CC-BY-4.0, Analytical Graphics, Inc., Ed Mackey, 2021',
    sourceSha256: '7ca161b7f8a9e4b2ac1f7f75816b5848bb31f3b4c226c4cb731b487c8809b756',
    scale: 1,
    settings: {
      ...SETTINGS,
      camera: { position: [0, 0, 40], target: [0, 0, 0], fov: 35, near: 0.01, far: 100 },
    },
  },
};

export function referenceCase(name) {
  const result = cases[name];
  if (!result) throw new Error(`Unknown reference case: ${name}`);
  return result;
}
