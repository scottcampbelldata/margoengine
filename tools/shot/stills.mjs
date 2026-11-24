// The stills of a shot (docs/shots.md, Stills): one render that captures only its probe frames, for a film's
// storyboard. Every frame before the last probe is still drawn, sub-frames and all, so each still is exactly the frame
// a full render keeps at that probe. Nothing else is kept, so this is never a motion render.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openShotPage, renderOnce } from './render.mjs';
import { probeFrames } from './shot-file.mjs';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const describeAdapter = (hardware) =>
  hardware?.webgpu
    ? [hardware.webgpu.vendor, hardware.webgpu.architecture, hardware.webgpu.description].filter(Boolean).join(' ')
    : 'no WebGPU adapter';

/**
 * Renders the probe frames of a parsed shot as `out/<probe>.png`, with `out/stills.json`: the shot's hash, each probe's
 * kept frame, file and sha256, and the adapter.
 * @param {object} file A parsed shot file (parseShot) that names probes.
 * @param {{ out: string, source?: string, log?: (line: string) => void }} options
 * @returns {Promise<object>} The stills.json manifest.
 * @throws TypeError when the shot names no probes.
 */
export async function shootStills(file, { out, source, log = console.error } = {}) {
  const probes = probeFrames(file),
    only = new Set(Object.values(probes));
  if (!only.size)
    throw new TypeError(
      `shot ${file.shot.id} names no probes: its stills are its probe frames, so name some in shot.probes`,
    );
  mkdirSync(out, { recursive: true });
  const work = join(out, '.stills-work');
  let browser;
  try {
    browser = await openShotPage(file);
    log(`stills of ${file.shot.id}: ${only.size} probe frames on ${describeAdapter(browser.hardware)}`);
    const a = await renderOnce(browser, file, {
      out: work,
      label: 'stills',
      write: true,
      only,
      progress: join(work, 'progress.json'),
      log,
    });
    const stills = {};
    for (const [name, index] of Object.entries(probes)) {
      const record = a.frames.find((frame) => frame.index === index);
      if (!record?.file) throw new Error(`the stills render kept no frame ${index} for probe ${name}`);
      writeFileSync(join(out, `${name}.png`), readFileSync(join(work, record.file)));
      stills[name] = { frame: index, file: `${name}.png`, sha256: record.sha256 };
    }
    const manifest = {
      format: 'margo-shot-stills',
      version: 1,
      id: file.shot.id,
      ...(source ? { source } : {}),
      shotSha256: sha256(JSON.stringify(file)),
      size: [...file.shot.size],
      fps: file.shot.fps,
      adapter: a.adapter,
      stills,
    };
    writeFileSync(join(out, 'stills.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    rmSync(work, { recursive: true, force: true });
    return manifest;
  } finally {
    await browser?.close();
  }
}
