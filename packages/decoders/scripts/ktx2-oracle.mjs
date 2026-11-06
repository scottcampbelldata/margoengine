// Writes tests/fixtures/ktx2-layers/records.json: the SHA-256 of every image of every fixture as Khronos KTX-Software
// extracts it (`ktx extract --raw --all`, transcoding Basis payloads to RGBA8), so the tests check Margo's decode against
// the real tool without needing it installed. Usage: node scripts/ktx2-oracle.mjs <path to ktx> [folder of .ktx2 files].
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [ktx, folder = resolve(import.meta.dirname, '../tests/fixtures/ktx2-layers')] = process.argv.slice(2);
const version = execFileSync(ktx, ['--version']).toString().trim(),
  records = { about: `sha256 per image from ${version}: ktx extract --raw --all`, files: {} };
for (const name of readdirSync(folder).filter((file) => file.endsWith('.ktx2'))) {
  const file = join(folder, name),
    basis = /vkFormat: VK_FORMAT_UNDEFINED/.test(execFileSync(ktx, ['info', file]).toString()),
    out = mkdtempSync(join(tmpdir(), 'ktx2-oracle-'));
  execFileSync(ktx, ['extract', '--raw', '--all', ...(basis ? ['--transcode', 'rgba8'] : []), file, join(out, 'x')]);
  records.files[name] = Object.fromEntries(
    readdirSync(join(out, 'x'))
      .sort()
      .map((image) => [
        image.replace(/^output_?|\.raw$/g, '') || 'image',
        createHash('sha256').update(readFileSync(join(out, 'x', image))).digest('hex'),
      ]),
  );
  rmSync(out, { recursive: true, force: true });
}
writeFileSync(join(folder, 'records.json'), JSON.stringify(records, null, 1) + '\n');
