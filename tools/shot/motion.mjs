// The `moving` evidence of a probe (docs/shots.md, Look checks): the frame after the probe and each pixel's motion to it,
// for headless/look's shimmerMoving (T4) and motionBlur (T8). The motion is the camera's alone (the world held still), made
// from the page's `depth` mask, the probe's eye and the view-projection of the probe and of the next frame.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePNG } from '@margoengine/headless/compare';
import { depthFromDistance, reprojectionMotion } from '@margoengine/headless/look';

/** How far away, in metres, a pixel with no geometry and no sea is taken to be (a sky): far enough to move only with the camera's turn. */
export const SKY_DISTANCE = 5000;

/**
 * The distance to the eye of each pixel of a `depth` mask that holds exp(-distance / scale) as 8-bit grey (as the
 * storm-light page writes it): 0 where nothing is drawn. Resolves a Float32Array, 0 for no geometry.
 * @param {{ width: number, height: number, data: Uint8Array }} mask
 * @param {number} scale metres
 */
export function distanceFromNearness(mask, scale) {
  const distance = new Float32Array(mask.width * mask.height);
  for (let i = 0; i < distance.length; i++) {
    const grey = mask.data[i * 4];
    if (grey > 0) distance[i] = -scale * Math.log(grey / 255);
  }
  return distance;
}

/**
 * Writes `probes/<name>.next.png` and `probes/<name>.motion.f32` (little-endian float32, x then y per pixel, the
 * frame's size) into the shot folder and returns the manifest's `moving` entry.
 * @param {{ out: string, name: string, nextFile: string, eye: number[], viewProjection: number[], nextViewProjection: number[], shot: { moving: { depthScale: number }, horizon: { y: number } | null, aovs: string[] } }} options
 */
export async function writeMoving({ out, name, nextFile, eye, viewProjection, nextViewProjection, shot }) {
  const read = async (aov) => decodePNG(new Uint8Array(readFileSync(join(out, 'probes', `${name}.${aov}.png`)))),
    depth = await read('depth'),
    water = shot.aovs.includes('water') ? await read('water') : null,
    distance = distanceFromNearness(depth, shot.moving.depthScale),
    ndc = depthFromDistance(distance, eye, viewProjection, depth.width, depth.height, {
      far: SKY_DISTANCE,
      ...(water && shot.horizon ? { water: water.data.filter((_, i) => i % 4 === 0), plane: shot.horizon.y } : {}),
    }),
    motion = reprojectionMotion(ndc, viewProjection, nextViewProjection, depth.width, depth.height);
  copyFileSync(join(out, nextFile), join(out, 'probes', `${name}.next.png`));
  writeFileSync(
    join(out, 'probes', `${name}.motion.f32`),
    Buffer.from(motion.data.buffer, motion.data.byteOffset, motion.data.byteLength),
  );
  return { next: `probes/${name}.next.png`, motion: `probes/${name}.motion.f32` };
}
