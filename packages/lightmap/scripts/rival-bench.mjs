// Cornell box irradiance against a Cycles bake. Cycles runs in Blender, outside this process.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { killTree } from '../../../scripts/gpu-lock.mjs';
import { bakeGlobalLightmap } from '../dist/global.js';
import {
  albedoOf,
  AREA_SAMPLES,
  calibrationIrradiance,
  BOUNCES,
  BOUNCE_RAYS,
  cornellScene,
  CYCLES_SAMPLES,
  PADDING,
  positionsOf,
  rectangleOf,
  SEED,
  TEXELS_PER_UNIT,
} from './cornell-box.mjs';

const blender = process.env.MARGO_BLENDER || 'C:\\blender\\blender.exe';
const outDir = process.env.MARGO_ENGINE_BENCH
  ? join(process.env.MARGO_ENGINE_BENCH, 'data', 'cornell')
  : 'C:\\Development\\Projects\\engine-bench\\batch-168\\data\\cornell';

const bakeOptions = (light, bounces) => ({
  radiometry: 'physical',
  texelsPerUnit: TEXELS_PER_UNIT,
  padding: PADDING,
  aoRays: 1,
  seed: SEED,
  areaSamples: AREA_SAMPLES,
  bounces,
  bounceRays: BOUNCE_RAYS,
  areaLights: [light],
});

function decoded(out) {
  return out.charts.map((chart) => {
    const pixels = [];
    for (let y = 0; y < chart.height; y++)
      for (let x = 0; x < chart.width; x++) {
        const at = ((chart.y + y) * out.width + chart.x + x) * 4;
        pixels.push([0, 1, 2].map((channel) => (out.textures.lightmap[at + channel] / 255) * out.lightmapScale));
      }
    return pixels;
  });
}

function mean(pixels) {
  const sum = [0, 0, 0];
  for (const pixel of pixels) for (let channel = 0; channel < 3; channel++) sum[channel] += pixel[channel];
  return sum.map((value) => value / pixels.length);
}

function runBlender(scenePath, outPath) {
  const script = fileURLToPath(new URL('./cornell-cycles.py', import.meta.url));
  return new Promise((resolve, reject) => {
    const log = createWriteStream(join(outDir, 'blender-log.txt'));
    const child = spawn(blender, ['--background', '--python', script, '--', scenePath, outPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, 300_000);
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    child.on('error', (error) => {
      clearTimeout(timer);
      log.end();
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      log.end();
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `blender ${timedOut ? 'TIMEOUT after 300 s' : `exited ${code}`}; see ${join(outDir, 'blender-log.txt')}`,
          ),
        );
    });
  });
}

const scene = cornellScene();
const peak = Math.max(...scene.light.color);
const cyclesLight = (light) => ({
  center: light.position,
  width: light.width,
  height: light.height,
  color: light.color.map((channel) => channel / Math.max(...light.color)),
  energy: Math.max(...light.color),
});
const payload = {
  samples: CYCLES_SAMPLES,
  bounces: BOUNCES,
  quads: scene.quads.map((quad) => ({
    name: quad.name,
    corners: quad.corners,
    albedo: quad.albedo,
    chart: quad.chart,
  })),
  light: cyclesLight(scene.light),
  calibration: {
    corners: [
      [-0.125, 0, -0.125],
      [-0.125, 0, 0.125],
      [0.125, 0, 0.125],
      [0.125, 0, -0.125],
    ],
    chart: scene.calibration.chart,
    light: cyclesLight(scene.calibration.light),
  },
};
await mkdir(outDir, { recursive: true });
const scenePath = join(outDir, 'scene.json');
const cyclesPath = join(outDir, 'cycles.json');
await writeFile(scenePath, JSON.stringify(payload));
const cyclesDone = runBlender(scenePath, cyclesPath);
const cornell = await bakeGlobalLightmap(
  { positions: positionsOf(scene.quads), albedo: albedoOf(scene.quads) },
  bakeOptions(scene.light, BOUNCES),
);
await cyclesDone;
const cycles = JSON.parse(await readFile(cyclesPath, 'utf8'));
// Independent solid-angle quadrature, never a fit to the Margo bake under test.
const margoCal = calibrationIrradiance(scene.calibration);
const cyclesCal = mean(cycles.calibration);
const factor = margoCal.map((value, channel) => value / cyclesCal[channel]);
const factorMean = factor.reduce((sum, value) => sum + value, 0) / 3;
if (cycles.quads.length !== scene.quads.length) throw new Error('cycles quad count does not match');
let absolute = 0;
let count = 0;
let cyclesSum = 0;
let margoSum = 0;
let maxAbs = 0;
const perQuad = [];
const margoPixels = decoded(cornell);
for (let q = 0; q < scene.quads.length; q++) {
  const ours = margoPixels[q];
  const theirs = cycles.quads[q];
  if (theirs.name !== scene.quads[q].name || theirs.pixels.length !== ours.length)
    throw new Error(`texel layout mismatch on ${scene.quads[q].name}`);
  let quadAbs = 0;
  for (let i = 0; i < ours.length; i++)
    for (let channel = 0; channel < 3; channel++) {
      const reference = theirs.pixels[i][channel] * factorMean;
      const delta = Math.abs(ours[i][channel] - reference);
      absolute += delta;
      quadAbs += delta;
      count++;
      cyclesSum += reference;
      margoSum += ours[i][channel];
      if (delta > maxAbs) maxAbs = delta;
    }
  perQuad.push({ name: scene.quads[q].name, mae: quadAbs / (ours.length * 3) });
}
const mae = absolute / count;
const result = {
  mae,
  relative: mae / (cyclesSum / count),
  maxAbs,
  factor: factorMean,
  factorRgb: factor,
  texels: count / 3,
  lightmapScale: cornell.lightmapScale,
  quantStep: cornell.lightmapScale / 255,
  margoMean: margoSum / count,
  cyclesMean: cyclesSum / count,
  samples: cornell.samples,
  rays: cornell.rays,
  blender: cycles.blender,
  perQuad,
  snaps: scene.quads
    .filter((quad) => quad.delta.some((value) => Math.abs(value) > 1e-6))
    .map((quad) => ({ name: quad.name, delta: quad.delta, flipped: quad.flipped })),
  rectangle: rectangleOf(scene.light).corner,
  peak,
};
console.log(
  `cornell-lightmap: mae ${mae.toFixed(6)} relative ${result.relative.toFixed(6)} max ${maxAbs.toFixed(6)} factor ${factorMean.toFixed(6)} texels ${result.texels} scale ${cornell.lightmapScale.toFixed(6)} step ${result.quantStep.toFixed(6)} blender ${cycles.blender}`,
);
console.log(`RESULT ${JSON.stringify(result)}`);
