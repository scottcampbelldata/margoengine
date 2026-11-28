import { Terrain } from '@margoengine/terrain';
import { asset } from './environment-films.js';
import { clamp, ramp } from './film.js';
import { asset as libraryAsset } from './assets.js';

const extent = [14977, 18556];
const origin = extent.map((metres) => -metres / 2);
const samples = 1025;
const survey = (name) => libraryAsset('four-demos-inputs/solar-v2/' + name);

async function image(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(25_000) });
  if (!response.ok) throw new Error('Surface imagery unavailable: ' + url);
  return createImageBitmap(await response.blob());
}

function canvas(size) {
  const result = document.createElement('canvas');
  result.width = size;
  result.height = size;
  return result.getContext('2d', { willReadFrequently: true });
}

export async function loadSolarLandscape() {
  const [heightResponse, aerial, ...sources] = await Promise.all([
    fetch(survey('antelope.f32'), { signal: AbortSignal.timeout(25_000) }),
    image(survey('antelope.jpg')),
    image(asset('gravelly_sand-diff.jpg')),
    image(asset('rocky_terrain_02-diff.jpg')),
    image(asset('concrete_floor_02-diff.jpg')),
  ]);
  if (!heightResponse.ok) throw new Error('The Antelope Valley elevation raster is unavailable.');
  const heights = new Float32Array(await heightResponse.arrayBuffer());
  if (heights.length !== samples * samples) throw new Error('Unexpected Antelope Valley elevation raster dimensions.');
  function sample(x, z) {
    const si = clamp((x - origin[0]) / extent[0]) * (samples - 1);
    const sj = clamp((z - origin[1]) / extent[1]) * (samples - 1);
    const i = Math.min(samples - 2, Math.floor(si));
    const j = Math.min(samples - 2, Math.floor(sj));
    const u = si - i;
    const v = sj - j;
    const index = j * samples + i;
    return (
      heights[index] * (1 - u) * (1 - v) +
      heights[index + 1] * u * (1 - v) +
      heights[index + samples] * (1 - u) * v +
      heights[index + samples + 1] * u * v
    );
  }

  const crop = canvas(2048);
  crop.drawImage(aerial, 0, 0, 2048, 2048);
  const tintData = crop.getImageData(0, 0, 2048, 2048);
  for (let j = 0; j < 2048; j++)
    for (let i = 0; i < 2048; i++) {
      const x = (i / 2047 - 0.5) * extent[0];
      const z = (j / 2047 - 0.5) * extent[1];
      const a = ramp(Math.hypot(x, z * 0.92), 570, 965);
      tintData.data[(j * 2048 + i) * 4 + 3] = Math.round(248 * a);
    }
  aerial.close();
  const mipPixels = sources.map((source) =>
    Array.from({ length: 10 }, (_, level) => {
      const size = 512 >> level;
      const ctx = canvas(size);
      ctx.drawImage(source, 0, 0, size, size);
      return ctx.getImageData(0, 0, size, size).data;
    }),
  );
  for (const source of sources) source.close();
  const makeTexture = (device, data, size, format) => {
    const texture = device.createTexture({
      size,
      format,
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });
    device.queue.writeTexture({ texture }, data, { bytesPerRow: size[0] * 4, rowsPerImage: size[1] }, size);
    return texture;
  };
  const maps = (device) => {
    const heightmap = makeTexture(device, heights, [samples, samples], 'r32float');
    const tint = makeTexture(device, tintData.data, [2048, 2048], 'rgba8unorm-srgb');
    const weight = makeTexture(device, new Uint8Array([255, 0, 0, 0]), [1, 1], 'rgba8unorm');
    const layers = device.createTexture({
      size: [512, 512, 4],
      mipLevelCount: 10,
      format: 'rgba8unorm-srgb',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });
    for (let layer = 0; layer < 4; layer++) {
      for (const [mipLevel, data] of mipPixels[layer % 3].entries()) {
        const size = 512 >> mipLevel;
        device.queue.writeTexture(
          { texture: layers, mipLevel, origin: [0, 0, layer] },
          data,
          { bytesPerRow: size * 4, rowsPerImage: size },
          [size, size, 1],
        );
      }
    }
    return { heightmap, layers, tint, weights: [weight, weight] };
  };
  return {
    sample,
    attach(engine) {
      return Terrain.attach(engine, {
        origin,
        size: extent,
        heightScale: 1,
        resolution: 96,
        levels: 9,
        cellSize: 1,
        clipmapAnchor: [0, 0],
        layers: Array.from({ length: 4 }, (_, i) => ({
          height: [-1000, 2500],
          slope: [0, 1],
          scale: 0.29,
          tint: i === 0,
          bump: 0.25,
          macro: 0.63,
        })),
        textures: maps,
      });
    },
  };
}
