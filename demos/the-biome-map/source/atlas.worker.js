import { BiomeWorld, quantizeClimate } from '@margoengine/biomes';
import { presets } from '@margoengine/biomes/presets';
import { multiNoise } from '@margoengine/biomes/multinoise';
import { relief, size, fieldSize, biomeKeys } from './relief.js';

const width = fieldSize, depth = fieldSize;
const height = new Float32Array(width * depth);
for (let z = 0; z < depth; z++) for (let x = 0; x < width; x++) {
  height[z * width + x] = relief(x / (width - 1), z / (depth - 1));
}
const classifier = multiNoise({
  axes: [
    {field: 'temperature', range: [-23, 33], weight: 2},
    {field: 'rainfall', range: [0, 2200], weight: 2},
  ],
  blend: .24,
  points: [
    {biome: 'temperate', at: {temperature: [7.8,25], rainfall: [850,2200]}},
    {biome: 'savanna', at: {temperature: [7,27], rainfall: [375,670]}},
    {biome: 'tundra', at: {temperature: [-22,3.0], rainfall: [0,1800]}},
    {biome: 'desert', at: {temperature: [7,32], rainfall: [0,230]}},
  ],
});
const biomes = biomeKeys.map(key => presets[key]);
const base = {latitude: 42, lapseRate: 6, wind: [1,.18], rainShadow: .72, inland: 0};
const baselineTemperature = quantizeClimate(base).seaTemperature / 100;
let world;
async function classify(temp, rain) {
  const shift = temp - baselineTemperature;
  const climate = {...base, equatorTemperature: 27+shift, poleTemperature: -20+shift, rainfall: rain};
  if (!world) {
    world = await BiomeWorld.create({
      seed: 7717, size, height: {samples: height, width, depth},
      resolution: 4, regionResolution: 256, tileSize: 512, workers: false,
      climate, classifier, biomes,
    });
  } else world.update({climate});
  const weights = new Uint8Array(width * depth * 4);
  const tallies = [0,0,0,0];
  let land = 0, sample, minRain = Infinity, maxRain = 0, minTemp = Infinity, maxTemp = -Infinity;
  for (let z = 0; z < depth; z++) for (let x = 0; x < width; x++) {
    const offset = z * width + x;
    if (height[offset] < 0) continue;
    land++;
    sample = world.sampleRegion(
      (x / (width - 1) - .5) * size[0], (z / (depth - 1) - .5) * size[1], sample,
    );
    const {temperature, rainfall} = sample;
    minRain = Math.min(minRain, rainfall);
    maxRain = Math.max(maxRain, rainfall);
    minTemp = Math.min(minTemp, temperature);
    maxTemp = Math.max(maxTemp, temperature);
    for (let i = 0; i < sample.biomes.length; i++) {
      const index = biomeKeys.indexOf(sample.biomes[i]);
      weights[offset*4+index] = Math.round(sample.weights[i] * 255);
      tallies[index] += sample.weights[i];
    }
  }
  return {weights, shares: tallies.map(v => v / land * 100), land, minRain, maxRain, minTemp, maxTemp};
}

self.addEventListener('message', async ({data: {id, temp, rain}}) => {
  try {
    const {weights, ...stats} = await classify(temp, rain);
    self.postMessage({id, weights, stats}, [weights.buffer]);
  } catch (error) {
    self.postMessage({id, error: error.message ?? String(error)});
  }
});
