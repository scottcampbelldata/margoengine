import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { displayImage } from './linear-image.mjs';
import { saveReference } from './reference.mjs';
import { encodePNG } from '../support/visual-image.js';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const benchRoot =
  process.env.MARGO_ENGINE_BENCH ?? fileURLToPath(new URL('../../../engine-bench', import.meta.url));
/** Only public Mitsuba APIs; bounded CPU reference execution, independent from the browser renderer. */
export async function capturePathReference(script, folder) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.env.MARGO_MITSUBA_PYTHON ?? join(benchRoot, 'batch-168/mitsuba-venv/Scripts/python.exe'),
      [script, folder],
      { stdio: 'inherit', windowsHide: true },
    );
    const timer = setTimeout(() => {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 15000,
      });
      reject(Error('Mitsuba exceeded its 20-minute process-tree deadline'));
    }, 20 * 60_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(Error(`Mitsuba exited ${code}`));
    });
  });
}
/** Verify both raw and display hashes before accepting/replacing a derived picture. */
export function readPathReference(folder, prefix, width, height, baseline) {
  const bytes = readFileSync(join(folder, prefix + '-rgb.f32')),
    linearSha256 = sha256(bytes);
  const image = displayImage(bytes, width, height),
    picture = encodePNG(image),
    referenceSha256 = sha256(picture);
  if (baseline) {
    assert.equal(linearSha256, baseline.linearSha256, 'Outside linear reference changed; frozen files preserved');
    assert.equal(referenceSha256, baseline.referenceSha256, 'Outside display reference changed');
  }
  saveReference(join(folder, prefix + '.png'), picture, baseline?.referenceSha256);
  return { image, linearSha256, referenceSha256, meta: JSON.parse(readFileSync(join(folder, prefix + '-meta.json'))) };
}
