// The `moving` evidence of a probe (docs/shots.md, Look checks): the frame after the probe and each pixel's motion to it,
// for headless/look's shimmerMoving (T4) and motionBlur (T8). The motion is the camera's alone (the world held still), made
// from the page's `depth` mask, the probe's eye and the view-projection of the probe and of the next frame.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePNG } from '@margoengine/headless/compare';
import { depthFromDistance, reprojectionMotion } from '@margoengine/headless/look';

/** How far away, in metres, a pixel with no geometry and no sea is taken to be (a sky): far enough to move only with the camera's turn. */
export const SKY_DISTANCE = 5000;

/**
 * The distance to the eye of each pixel of a `depth` mask that holds exp(-distance / scale): 0 where nothing is drawn.
 * `value` holds the mask's floats (the shot tool's `depth.f32`); without it `data` is the 8-bit grey RGBA of the PNG,
 * which puts every distance below scale / 510 on 255 (no distance) and steps far ground by metres. Returns a
 * Float32Array, 0 for no geometry.
 * @param {{ width: number, height: number, data?: Uint8Array, value?: Float32Array }} mask
 * @param {number} scale metres
 */
export function distanceFromNearness(mask, scale) {
  const distance = new Float32Array(mask.width * mask.height);
  for (let i = 0; i < distance.length; i++) {
    const nearness = mask.value ? mask.value[i] : mask.data[i * 4] / 255;
    if (nearness > 0 && nearness < 1) distance[i] = -scale * Math.log(nearness);
  }
  return distance;
}

/** `count` float32 values of a file, little-endian as the page's and this machine's are. */
const readFloats = (file, count) => {
  const bytes = readFileSync(file);
  if (bytes.byteLength !== count * 4)
    throw new RangeError(`${file} holds ${bytes.byteLength} bytes, not ${count * 4}; render the shot again`);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
};

/** A frame's NDC depth from its depth mask (PNG and, when kept, floats) and its water mask, files of the shot folder. */
async function ndcOf({ out, png, floats, waterPng, eye, viewProjection, shot }) {
  const decode = async (file) => decodePNG(new Uint8Array(readFileSync(join(out, file)))),
    depth = await decode(png),
    water = waterPng ? await decode(waterPng) : null,
    exact = floats && existsSync(join(out, floats)) ? readFloats(join(out, floats), depth.width * depth.height) : null,
    distance = distanceFromNearness(exact ? { ...depth, value: exact } : depth, shot.moving.depthScale);
  return {
    width: depth.width,
    height: depth.height,
    ndc: depthFromDistance(distance, eye, viewProjection, depth.width, depth.height, {
      far: SKY_DISTANCE,
      ...(water && shot.horizon ? { water: water.data.filter((_, i) => i % 4 === 0), plane: shot.horizon.y } : {}),
    }),
  };
}

const writeMotion = (out, file, motion) =>
  writeFileSync(join(out, file), Buffer.from(motion.data.buffer, motion.data.byteOffset, motion.data.byteLength));

/**
 * Writes `probes/<name>.next.png` and `probes/<name>.motion.f32` (little-endian float32, x then y per pixel, the
 * frame's size) into the shot folder and returns the manifest's `moving` entry. With `next` (the next frame's eye and
 * its `depth` and `water` mask records, {file, exact}) it also writes `probes/<name>.back.f32`, each pixel of the next
 * frame's motion back to the probe, for shimmerMoving's forward-backward occlusion test.
 * @param {{ out: string, name: string, nextFile: string, next?: { eye?: number[], depth?: { file: string, exact?: string }, water?: { file: string } }, eye: number[], viewProjection: number[], nextViewProjection: number[], shot: { moving: { depthScale: number }, horizon: { y: number } | null, aovs: string[] } }} options
 */
export async function writeMoving({ out, name, nextFile, next, eye, viewProjection, nextViewProjection, shot }) {
  const water = shot.aovs.includes('water'),
    { ndc, width, height } = await ndcOf({
      out,
      png: `probes/${name}.depth.png`,
      floats: `probes/${name}.depth.f32`,
      waterPng: water ? `probes/${name}.water.png` : null,
      eye,
      viewProjection,
      shot,
    }),
    motion = reprojectionMotion(ndc, viewProjection, nextViewProjection, width, height);
  copyFileSync(join(out, nextFile), join(out, 'probes', `${name}.next.png`));
  writeMotion(out, `probes/${name}.motion.f32`, motion);
  const entry = { next: `probes/${name}.next.png`, motion: `probes/${name}.motion.f32` };
  if (!next?.eye || !next.depth?.file) return entry;
  const after = await ndcOf({
    out,
    png: next.depth.file,
    floats: next.depth.exact,
    waterPng: water ? next.water?.file : null,
    eye: next.eye,
    viewProjection: nextViewProjection,
    shot,
  });
  writeMotion(out, `probes/${name}.back.f32`, reprojectionMotion(after.ndc, nextViewProjection, viewProjection, width, height));
  return { ...entry, back: `probes/${name}.back.f32` };
}
