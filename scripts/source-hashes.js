import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export async function directoryHashes(folder) {
  const files = []; async function visit(directory) { for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) { const path = `${directory}/${entry.name}`; if (entry.isDirectory()) await visit(path); else if (entry.isFile()) files.push(path); else throw new TypeError(`Fingerprint input must be a regular file: ${path}`); } } await visit(folder);
  return Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
}
