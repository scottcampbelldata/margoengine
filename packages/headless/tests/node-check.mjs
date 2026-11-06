// Real-GPU proof in Node, with no browser anywhere (from the repository root after building packages):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/headless/tests/node-check.mjs
// Runs every README example that names the `webgpu` binding, as written, each in its own Node process, and reads back
// the files it wrote. MARGO_NODE_GPU=<adapter name> picks an adapter, for example 'Microsoft Basic Render Driver' (WARP,
// software) on a Windows runner with no GPU.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { decodePNG } from '../../../tests/support/png.js';

const here = fileURLToPath(new URL('.', import.meta.url)),
  scratch = `${here}.node-check-${process.pid}/`,
  readme = await readFile(`${here}../README.md`, 'utf8'),
  examples = [...readme.replaceAll('\r\n', '\n').matchAll(/```ts\n(.*?)```/gs)]
    .map((match) => match[1])
    .filter((code) => code.includes("from 'webgpu'"));
assert.equal(examples.length, 3, 'the README has three examples on the binding');

const flags = process.env.MARGO_NODE_GPU ? `[${JSON.stringify(`adapter=${process.env.MARGO_NODE_GPU}`)}]` : '[]';

/** Pixels of `bytes` that differ from the corner: a picture of nothing has none. */
async function drawn(bytes) {
  const { data } = await decodePNG(new Uint8Array(bytes));
  let count = 0;
  for (let i = 0; i < data.length; i += 4)
    if (Math.abs(data[i] - data[0]) + Math.abs(data[i + 1] - data[1]) + Math.abs(data[i + 2] - data[2]) > 16) count++;
  return count;
}

await mkdir(scratch);
try {
  for (const [index, code] of examples.entries()) {
    const folder = `${scratch}${index}/`;
    await mkdir(folder);
    await writeFile(`${folder}example.mts`, code.replace("create([])", `create(${flags})`));
    const run = spawnSync(process.execPath, ['example.mts'], { cwd: folder, encoding: 'utf8', timeout: 120_000 });
    assert.equal(run.status, 0, `example ${index} ended by itself: ${run.signal ?? ''} ${run.stderr.slice(-1500)}`);
    const files = (await readdir(folder)).filter((name) => name.endsWith('.png'));
    assert.ok(files.length > 0, `example ${index} wrote a picture`);
    for (const name of [files[0], files.at(-1)]) {
      const count = await drawn(await readFile(folder + name));
      assert.ok(count > 1000, `${name} of example ${index} shows the scene (${count} pixels)`);
    }
    console.log(`ok README example ${index} in Node: ${files.length} file(s)`);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
