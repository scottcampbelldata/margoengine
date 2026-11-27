// Outside files a check reads: each pinned by address and SHA-256 and kept in a folder git ignores. A check never
// fetches one unless it was started with --download. Without the flag an absent or changed file fails the check, which
// names every one and the command that fetches them (tests/check-downloads.test.js).
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fetchFixture } from './fetch-fixture.mjs';

/** Whether a check was started with the one flag that lets it fetch. */
export const downloadAllowed = (argv = process.argv.slice(2)) => argv.includes('--download');

const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Reads pinned files and returns their bytes in row order. A row is `{ path, url, sha256, size? }`. `command` is how
 * the user runs this check; `--download` is added to it in the failure message. `download` (default false) allows the
 * absent and changed files to be fetched, each checked against its pin before it is written.
 */
export async function pinnedFiles(rows, { command, download = false, fetch } = {}) {
  const files = [],
    wanted = [];
  for (const [index, row] of rows.entries()) {
    let bytes;
    try {
      bytes = await readFile(row.path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (bytes && sha256Of(bytes) === row.sha256) files[index] = bytes;
    else wanted.push({ ...row, index, problem: bytes ? 'changed' : 'missing' });
  }
  if (wanted.length && !download)
    throw new Error(
      [
        `${wanted.length} of ${rows.length} pinned files this check reads are missing or changed:`,
        ...wanted.map((row) => `  ${row.problem}: ${row.path} (${row.url})`),
        `Nothing was fetched. To fetch them, run: ${command} --download`,
      ].join('\n'),
    );
  for (const row of wanted) {
    await fetchFixture(row.url, row.path, row.sha256, { fetch, maxBytes: row.size ?? 256 << 20 });
    files[row.index] = await readFile(row.path);
  }
  return files;
}
