// `node scripts/pack-student-kit.mjs`: the zip a class or tester gets instead of a clone. It holds every package packed as npm
// would publish it (`margo-packages/*.tgz`), the example models the beginner and game guides tell a reader to copy
// (`examples/assets/`), those guides and the README, and a NOTICE naming each model's source and licence. Written to
// test-results/margo-student-kit.zip, with one top-level folder, margo-student-kit/, so it unzips next to a project.
//   node scripts/pack-student-kit.mjs               builds the packages, packs them and writes the zip
//   node scripts/pack-student-kit.mjs --no-build    packs what is built already
//   node scripts/pack-student-kit.mjs --out=<file>  writes the zip there instead
// Only models listed in KIT_MODELS go in, and every model a kit guide names must be listed there with a licence that
// allows redistribution (tests/pack-student-kit.test.js checks both), so a guide that starts naming another model fails
// the test until its licence is recorded.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The folder every entry of the zip sits in. */
export const KIT_FOLDER = 'margo-student-kit';

/** The documents the kit carries: the README (Install, Quickstart), the guides the beginner and game tasks use, and the known lists. */
export const KIT_DOCUMENTS = [
  'README.md',
  'LICENSE',
  'NOTICE',
  'docs/guides/loading-gltf.md',
  'docs/guides/kits.md',
  'docs/guides/walkthrough.md',
  'docs/guides/animation.md',
  // What getting started tells a tester to search before filing a bug.
  'docs/known-bugs.md',
  'docs/limits.md',
];

/** The documents whose `examples/assets/` models the kit carries: the README and the guides, not the known lists. */
export const isGuide = (path) => path === 'README.md' || path.startsWith('docs/guides/');

/** Licences that allow the kit to pass a file on unchanged. */
export const REDISTRIBUTABLE = new Set(['CC0-1.0', 'CC-BY-4.0', 'Apache-2.0', 'MIT']);

/**
 * The models the kit may carry, with where each came from and its licence, as recorded in examples/assets/ATTRIBUTION.md
 * and THIRD-PARTY-NOTICES.md.
 */
export const KIT_MODELS = {
  'flight-helmet.glb': {
    name: 'Flight Helmet',
    source: 'https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/FlightHelmet',
    licence: 'CC0-1.0',
    credit: 'Khronos glTF Sample Assets, (c) 2018, Public; conversion from Maya credited to Gary Hsu. Repacked with 1024-pixel JPEG maps and quantized attributes.',
  },
  'robot-expressive.glb': {
    name: 'RobotExpressive',
    source: 'https://github.com/mrdoob/three.js/tree/dev/examples/models/gltf/RobotExpressive',
    licence: 'CC0-1.0',
    credit: 'Model by Tomas Laulhe (https://www.patreon.com/quaternius); facial morphs and glTF conversion by Don McCurdy.',
  },
};

/** Every `examples/assets/<file>` a document names, in order of first mention. */
export function referencedModels(markdowns) {
  const found = new Set();
  for (const text of markdowns) for (const match of text.matchAll(/examples\/assets\/([\w./-]+?\.(?:glb|gltf|bin|png|jpe?g|ktx2|hdr))/g)) found.add(match[1]);
  return [...found];
}

/** The NOTICE.md that goes in the zip: the engine's licence and each model's name, file, source, licence and credit. */
export function noticeText(models) {
  const lines = [
    '# Margo Engine student kit: notices',
    '',
    'The packages in margo-packages/ and the documents in this folder are Margo Engine, Apache-2.0 (see LICENSE and NOTICE).',
    'Each package tarball carries its own licence file and any notices of its own.',
    '',
    'The example models in examples/assets/ are other people\'s work, passed on unchanged under these licences:',
    '',
  ];
  for (const file of models) {
    const model = KIT_MODELS[file];
    if (!model) throw new Error(`no licence recorded for examples/assets/${file}; add it to KIT_MODELS`);
    if (!REDISTRIBUTABLE.has(model.licence)) throw new Error(`examples/assets/${file} is ${model.licence}, which the kit may not pass on`);
    lines.push(`- examples/assets/${file}: ${model.name}. Licence ${model.licence}. Source ${model.source}. ${model.credit}`);
  }
  lines.push('', 'CC0-1.0: https://creativecommons.org/publicdomain/zero/1.0/', '');
  return lines.join('\n');
}

/** DOS date and time of `date`, as zip headers store them. */
function dosTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * A zip archive of `entries` ([{ name, data }], forward-slash names), each deflated unless that makes it larger
 * (tarballs and GLBs are compressed already, so they are stored). UTF-8 names, no zip64: the kit is far below 4 GB.
 */
export function zipEntries(entries, { date = new Date() } = {}) {
  const { time, date: day } = dosTime(date),
    locals = [],
    central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const bytes = Buffer.from(data),
      packed = deflateRawSync(bytes, { level: 9 }),
      deflate = packed.length < bytes.length,
      body = deflate ? packed : bytes,
      nameBytes = Buffer.from(name, 'utf8'),
      sum = crc32(bytes);
    if (offset + body.length > 0xffffffff) throw new RangeError('the kit is too large for a zip without zip64');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(deflate ? 8 : 0, 10);
    head.writeUInt16LE(time, 12);
    head.writeUInt16LE(day, 14);
    head.writeUInt32LE(sum, 16);
    head.writeUInt32LE(body.length, 20);
    head.writeUInt32LE(bytes.length, 24);
    head.writeUInt16LE(nameBytes.length, 28);
    head.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    central.push(head, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** The entries of a zip written by zipEntries (or any zip without zip64 or encryption): [{ name, data }]. */
export function unzipEntries(zip) {
  const endAt = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new Error('not a zip: no end of central directory');
  const count = zip.readUInt16LE(endAt + 10),
    entries = [];
  let at = zip.readUInt32LE(endAt + 16);
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error(`central directory entry ${i} is damaged`);
    const method = zip.readUInt16LE(at + 10),
      sum = zip.readUInt32LE(at + 16),
      size = zip.readUInt32LE(at + 20),
      nameLength = zip.readUInt16LE(at + 28),
      extra = zip.readUInt16LE(at + 30),
      comment = zip.readUInt16LE(at + 32),
      local = zip.readUInt32LE(at + 42),
      name = zip.toString('utf8', at + 46, at + 46 + nameLength),
      start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28),
      body = zip.subarray(start, start + size),
      data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    if (crc32(data) !== sum) throw new Error(`${name}: CRC mismatch`);
    entries.push({ name, data });
    at += 46 + nameLength + extra + comment;
  }
  return entries;
}

/**
 * npm's own script, run by this Node: npm_execpath when npm started this script, else the npm that ships beside Node.
 * No shell, so no npm.cmd and nothing for a shell to read into the arguments.
 */
function npmCli() {
  const beside = [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  const found = [process.env.npm_execpath, ...beside].find((path) => path?.endsWith('.js') && existsSync(path));
  if (!found) throw new Error('npm not found: run this with npm (npm exec, npm run) or from a Node install that includes npm');
  return found;
}

function npm(args, options) {
  const run = spawnSync(process.execPath, [npmCli(), ...args], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    timeout: 30 * 60_000,
    ...options,
  });
  // npm pack lists every file it packs on stderr; shown only when the step fails.
  if (run.status !== 0)
    throw new Error(`npm ${args.join(' ')} failed (${run.error?.message ?? `exit ${run.status}`})
${String(run.stderr).slice(-4000)}`);
  return run.stdout;
}

/** Packs every workspace package into `folder` as npm would publish it (what `npm run pack:packages` does). */
export function packPackages(folder) {
  npm(['pack', '--workspace', 'packages', '--ignore-scripts', '--pack-destination', relative(root, folder)]);
}

/**
 * Builds (unless `build` is false) and packs every package, then writes the kit zip to `out`. Returns its summary.
 * `source` is the checkout the documents and models come from; `pack(folder)` writes the tarballs (packPackages).
 */
export function packStudentKit({
  build = true,
  out = join(root, 'test-results/margo-student-kit.zip'),
  source = root,
  pack = packPackages,
  scratch = join(root, 'test-results/student-kit-packs'),
} = {}) {
  const documents = KIT_DOCUMENTS.map((path) => ({ path, text: readFileSync(join(source, path)) }));
  const models = referencedModels(documents.filter(({ path }) => isGuide(path)).map(({ text }) => String(text)));
  const notice = noticeText(models);
  if (build) npm(['run', 'build:packages']);
  const packs = scratch;
  rmSync(packs, { recursive: true, force: true });
  mkdirSync(packs, { recursive: true });
  pack(packs);
  const tarballs = readdirSync(packs).filter((name) => name.endsWith('.tgz')).sort();
  if (!tarballs.length) throw new Error('npm pack wrote no tarballs');
  const entries = [
    ...documents.map(({ path, text }) => ({ name: `${KIT_FOLDER}/${path}`, data: text })),
    { name: `${KIT_FOLDER}/NOTICE.md`, data: notice },
    ...models.map((file) => {
      const path = join(source, 'examples/assets', file),
        data = readFileSync(path);
      // A Git LFS pointer is about 130 bytes of text; a clone made without the LFS files has only those.
      if (data.length < 1024 && data.toString('latin1').startsWith('version https://git-lfs'))
        throw new Error(`examples/assets/${file} is a Git LFS pointer; run git lfs pull first`);
      return { name: `${KIT_FOLDER}/examples/assets/${file}`, data };
    }),
    ...tarballs.map((name) => ({ name: `${KIT_FOLDER}/margo-packages/${name}`, data: readFileSync(join(packs, name)) })),
  ];
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, zipEntries(entries));
  rmSync(packs, { recursive: true, force: true });
  return { out, bytes: statSync(out).size, tarballs: tarballs.length, models, documents: KIT_DOCUMENTS };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outArg = process.argv.find((arg) => arg.startsWith('--out='))?.slice('--out='.length);
  const summary = packStudentKit({ build: !process.argv.includes('--no-build'), ...(outArg ? { out: resolve(outArg) } : {}) });
  console.log(
    `${relative(root, summary.out) || basename(summary.out)}: ${summary.bytes} bytes, ${summary.tarballs} packages, models ${summary.models.join(', ')}`,
  );
}

