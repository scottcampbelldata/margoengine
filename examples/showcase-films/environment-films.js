import { createMesh, loadTexture, Material, Texture } from '@margoengine/materials';
import { heightfieldGeometry } from '@margoengine/terrain';
import { asset as libraryAsset } from './assets.js';

export const asset = (name) => libraryAsset('environment-films/' + name);

export function brushTexture(w, h, paint, colorSpace = 'srgb') {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  paint(canvas.getContext('2d'), w, h);
  return new Texture(canvas, { colorSpace, wrapS: 'repeat', wrapT: 'repeat' });
}

export async function surface(name, overrides = {}) {
  const textures = await Promise.all(
    ['diff', 'nor_gl', 'rough'].map((channel, i) =>
      loadTexture(asset(name + '-' + channel + '.jpg'), {
        colorSpace: i === 0 ? 'srgb' : 'linear',
        wrapS: 'repeat',
        wrapT: 'repeat',
        signal: AbortSignal.timeout(20000),
      }),
    ),
  );
  const [map, normalMap, roughnessMap] = textures;
  return {
    material: new Material({ map, normalMap, roughnessMap, color: '#ffffff', roughness: 0.92, ...overrides }),
    dispose: () => textures.forEach((texture) => texture.dispose()),
  };
}

export function texturedGround(engine, height, material, options, repeatMetres) {
  const mesh = heightfieldGeometry(height, options);
  for (let i = 0; i < mesh.uvs.length; i += 2) {
    mesh.uvs[i] *= options.size[0] / repeatMetres;
    mesh.uvs[i + 1] *= options.size[1] / repeatMetres;
  }
  return createMesh(engine, mesh, material);
}

export const at = (x, y, z, angle = 0) => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, x, y, z, 1];
};
