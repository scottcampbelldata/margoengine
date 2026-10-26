import { mkdir, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Prepares the visual check's output folder. Visual checks share the GPU (scripts/gpu-lock.mjs), so another one may be
 * writing the same folder: this clears only what this run will write again (`mine`, view ids, plus index.html) and what
 * belongs to no known view (`known`), and leaves the files of the other views alone.
 */
export async function clearVisualOutput(out, { mine, known }) {
  await mkdir(out, { recursive: true });
  const own = new Set(mine);
  for (const name of await readdir(out)) {
    const id = known.find((k) => name.startsWith(`${k}.`));
    if (name === 'index.html' || id === undefined || own.has(id)) await rm(resolve(out, name), { force: true });
  }
}
