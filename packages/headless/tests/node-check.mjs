// Real-GPU proof in Node, with no browser anywhere (from the repository root after building packages):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/headless/tests/node-check.mjs
// Runs every README example that names the `webgpu` binding, as written, each in its own Node process, and reads back
// the files it wrote: every one holds bytes, and a PNG or EXR shows the scene. A comparing example gets its reference
// from its own scene, made first in another process. The ffmpeg example needs ffmpeg on the path: without it the check
// fails before running anything, saying the example did not run (this is not a pass). MARGO_NODE_GPU=<adapter name> picks an adapter, for example 'Microsoft Basic Render Driver' (WARP,
// software) on a Windows runner with no GPU.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseEXR } from '@margoengine/environment';
import { decodePNG } from '../../../tests/support/png.js';
import { cannotRun, needs, nodeExamples, referenceMaker } from './readme-examples.mjs';

const here = fileURLToPath(new URL('.', import.meta.url)),
  scratch = `${here}.node-check-${process.pid}/`,
  examples = nodeExamples(await readFile(`${here}../README.md`, 'utf8')),
  hasFFmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

const missing = cannotRun(examples, { ffmpeg: hasFFmpeg });
if (missing) {
  console.error(`==== FAIL: ${missing} ====`);
  process.exit(1);
}

const flags = process.env.MARGO_NODE_GPU ? `[${JSON.stringify(`adapter=${process.env.MARGO_NODE_GPU}`)}]` : '[]';

/** Pixels of a PNG or EXR file that differ from the corner: a picture of nothing has none. */
async function drawn(name, bytes) {
  if (name.endsWith('.exr')) {
    const { data } = parseEXR(bytes);
    let count = 0;
    for (let i = 0; i < data.length; i += 4)
      if (Math.abs(data[i] - data[0]) + Math.abs(data[i + 1] - data[1]) + Math.abs(data[i + 2] - data[2]) > 0.05)
        count++;
    return count;
  }
  const { data } = await decodePNG(new Uint8Array(bytes));
  let count = 0;
  for (let i = 0; i < data.length; i += 4)
    if (Math.abs(data[i] - data[0]) + Math.abs(data[i + 1] - data[1]) + Math.abs(data[i + 2] - data[2]) > 16) count++;
  return count;
}

/** Runs `file` in `folder` with Node, and fails naming `what` unless it ended by itself with status 0. */
function run(folder, file, what) {
  const result = spawnSync(process.execPath, [file], { cwd: folder, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, `${what} ended by itself: ${result.signal ?? ''} ${result.stderr.slice(-1500)}`);
}

await mkdir(scratch);
try {
  for (const [index, code] of examples.entries()) {
    const need = needs(code);
    const folder = `${scratch}${index}/`,
      source = code.replace('create([])', `create(${flags})`);
    await mkdir(folder);
    if (need.reference) {
      await writeFile(`${folder}reference.mts`, referenceMaker(source));
      run(folder, 'reference.mts', `the reference for example ${index}`);
    }
    await writeFile(`${folder}example.mts`, source);
    run(folder, 'example.mts', `example ${index}`);
    const files = (await readdir(folder)).filter((name) => /\.(png|jpg|webp|exr|mp4|webm)$/.test(name)).sort();
    assert.ok(files.length > 0, `example ${index} wrote a picture or a video`);
    for (const name of files)
      assert.ok((await stat(folder + name)).size > 0, `${name} of example ${index} holds bytes`);
    // A sequence is checked at its first and last picture.
    const pictures = files.filter((name) => /\.(png|exr)$/.test(name));
    for (const name of new Set([pictures[0], pictures.at(-1)].filter(Boolean))) {
      const count = await drawn(name, await readFile(folder + name));
      assert.ok(count > 1000, `${name} of example ${index} shows the scene (${count} pixels)`);
    }
    console.log(`ok README example ${index} in Node: ${files.length} file(s), ${files.slice(0, 3).join(', ')}`);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
