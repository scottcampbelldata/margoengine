// The Unity precision importer's own PNG reader (C#): a tRNS chunk (W3C PNG, third edition, 11.3.2.1) makes the
// one RGB key colour of a colour type 2 image transparent, and may not appear after IDAT or for colour type 6.
// The text assertion always runs; the C# itself is compiled and run where a C# compiler is installed (Unity's Mono
// mcs, or mcs or csc on the PATH), like the Python checks in precision-native.test.js.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { createUnityPrecisionImporter } from '../dist/unity-precision-importer.js';

const lines = createUnityPrecisionImporter({ appName: 'Acme', extension: 'acmeunity' }).split('\n');
/** One static member of the importer: a one-line member, or a block up to its closing brace. */
function member(pattern) {
  const at = lines.findIndex((line) => pattern.test(line)),
    out = [lines[at]];
  assert.ok(at >= 0, String(pattern));
  if (/\{\s*$/.test(lines[at])) {
    let next = at + 1;
    while (!/^ {4}\}/.test(lines[next])) out.push(lines[next++]);
    out.push(lines[next]);
  }
  return out.join('\n');
}
const reader = [/static void Need\(/, /static int Be32\(/, /static byte\[\] OriginalPngPixels\(/]
  .map(member)
  .join('\n');

const crc = (bytes) => {
  let c = ~0;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};
/** A 2x1 PNG8 of colour type `type` with `before` chunks ahead of IDAT and `after` chunks behind it. */
const png = (type, raw, before = [], after = []) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = type;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    ...before,
    chunk('IDAT', deflateSync(Buffer.from(raw))),
    ...after,
    chunk('IEND', []),
  ]);
};
const key = chunk('tRNS', [0, 1, 0, 2, 0, 3]),
  rgb = [0, 10, 20, 30, 1, 2, 3];

/** A C# compiler and how to run what it builds, or undefined on a machine with none. */
function findCSharp() {
  const hub = 'C:/Program Files/Unity/Hub/Editor';
  if (process.platform === 'win32' && existsSync(hub))
    for (const version of readdirSync(hub).sort().reverse()) {
      const mono = join(hub, version, 'Editor/Data/MonoBleedingEdge');
      if (existsSync(join(mono, 'bin/mono.exe')) && existsSync(join(mono, 'lib/mono/4.5/mcs.exe')))
        return {
          compile: [join(mono, 'bin/mono.exe'), [join(mono, 'lib/mono/4.5/mcs.exe')]],
          run: [join(mono, 'bin/mono.exe'), []],
        };
    }
  for (const command of ['mcs', 'csc']) {
    const { error, status } = spawnSync(command, ['-help'], { timeout: 60_000 });
    if (error && error.code !== 'ENOENT') throw error;
    if (status === 0) return { compile: [command, []], run: process.platform === 'win32' ? null : ['mono', []] };
  }
  return undefined;
}

test('the C# PNG reader applies an RGB tRNS key and refuses a misplaced or disallowed tRNS', () => {
  assert.match(reader, /kind=="tRNS"/);
  const sharp = findCSharp();
  if (!sharp) return; // no C# compiler on this machine; the text assertion above still holds
  const dir = mkdtempSync(join(tmpdir(), 'margo-unity-png-'));
  try {
    const files = {
      plain: png(2, rgb),
      key: png(2, rgb, [key]),
      late: png(2, rgb, [], [key]),
      rgba: png(6, [0, 10, 20, 30, 255, 1, 2, 3, 255], [key]),
    };
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name + '.png'), bytes);
    writeFileSync(
      join(dir, 'reader.cs'),
      `using System;using System.IO;using System.Linq;class Reader{${reader}
static void Main(string[] names){foreach(var name in names){try{int w,h;Console.WriteLine(name+" "+string.Join(",",OriginalPngPixels(File.ReadAllBytes(name+".png"),out w,out h)));}catch(InvalidDataException e){Console.WriteLine(name+" "+e.Message);}}}}`,
    );
    const [compiler, prefix] = sharp.compile,
      built = spawnSync(compiler, [...prefix, '-nologo', '-out:' + join(dir, 'reader.exe'), join(dir, 'reader.cs')], {
        encoding: 'utf8',
        timeout: 120_000,
      });
    assert.ifError(built.error);
    assert.equal(built.status, 0, built.stdout + built.stderr);
    const [runner, args] = sharp.run ?? [join(dir, 'reader.exe'), []],
      ran = spawnSync(runner, [...args, ...(sharp.run ? [join(dir, 'reader.exe')] : []), ...Object.keys(files)], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 60_000,
      });
    assert.ifError(ran.error);
    assert.equal(ran.status, 0, ran.stderr);
    assert.deepEqual(ran.stdout.trim().split(/\r?\n/), [
      'plain 10,20,30,255,1,2,3,255',
      'key 10,20,30,255,1,2,3,0',
      'late ACME_UNITY_PRECISION: Original PNG tRNS (one RGB key before IDAT)',
      'rgba ACME_UNITY_PRECISION: Original PNG tRNS (one RGB key before IDAT)',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
