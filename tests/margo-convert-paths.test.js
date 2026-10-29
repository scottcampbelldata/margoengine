// margo-convert file-system containment (bugs 42 b, 42 c and 47). A .gltf's external URIs, a build manifest's output
// paths and the CLI's output path are input the tool did not choose: none may read, delete or overwrite a file
// outside the folder it belongs to. Symlinks are made as directory junctions, which Windows allows without
// administrator rights (and which are plain symlinks elsewhere).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, optimizeModelFile, sha256 } from '../tools/margo-convert/pipeline/build.js';
import { inside, sameFile } from '../tools/margo-convert/pipeline/paths.js';
import { preset } from '../tools/margo-convert/pipeline/presets.js';

const root = resolve(import.meta.dirname, '..');
const triangle = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
/** A one-triangle .gltf whose buffer is read from `uri`. */
const gltf = (uri) =>
  JSON.stringify({
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    buffers: [{ byteLength: 36, uri }],
  });

/** A temp folder with assets/ (the model folder), secret/secret.bin beside it and a junction assets/link -> secret. */
function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'margo-convert-paths-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const assets = join(dir, 'assets'),
    secret = join(dir, 'secret');
  mkdirSync(assets);
  mkdirSync(secret);
  writeFileSync(join(secret, 'secret.bin'), triangle);
  writeFileSync(join(assets, 'tri.bin'), triangle);
  symlinkSync(secret, join(assets, 'link'), 'junction');
  return { dir, assets, secret };
}

const escapes = (secret) => [
  '../secret/secret.bin',
  '..%2fsecret%2fsecret.bin',
  '..%5Csecret%5Csecret.bin',
  join(secret, 'secret.bin'),
  join(secret, 'secret.bin').replace(/\\/g, '/'),
  'link/secret.bin',
];

test('inside() refuses .., absolute, drive, UNC and NUL paths and symlink escapes (bug 42 b)', (t) => {
  const { assets, secret } = workspace(t);
  assert.equal(inside(assets, 'tri.bin'), join(assets, 'tri.bin'));
  assert.equal(inside(assets, 'sub/../tri.bin'), join(assets, 'tri.bin'));
  assert.equal(inside(assets, 'not-yet/made.bin'), join(assets, 'not-yet/made.bin'));
  assert.equal(inside(assets, '..foo.bin'), join(assets, '..foo.bin'));
  for (const path of [
    '../secret/secret.bin',
    'a/../../secret/secret.bin',
    join(secret, 'secret.bin'),
    '/etc/passwd',
    '\\Windows\\win.ini',
    'C:\\Windows\\win.ini',
    'C:win.ini',
    '\\\\server\\share\\x.bin',
    '//server/share/x.bin',
    'tri.bin\0.png',
    'link/secret.bin',
    'link/not-there/x.bin',
    '',
  ])
    assert.equal(inside(assets, path), undefined, path);
});

test('a .gltf whose external URI leaves its folder is refused before the file is read (bug 42 b)', async (t) => {
  const { assets, secret } = workspace(t);
  const model = join(assets, 'scene.gltf');
  const ok = await optimizeModelFile(model, new TextEncoder().encode(gltf('tri.bin')), preset('web'));
  assert.ok(ok.glb.length > 0, 'a URI inside the folder still loads');
  for (const uri of escapes(secret))
    await assert.rejects(
      optimizeModelFile(model, new TextEncoder().encode(gltf(uri)), preset('web')),
      (error) =>
        error.name === 'MargoError' &&
        error.code === 'failed' &&
        /is outside the model's folder; copy it next to the \.gltf/.test(error.message),
      uri,
    );
});

test('build marks such a .gltf failed and never treats the outside file as its dependency (bug 42 b)', async (t) => {
  const { dir, assets, secret } = workspace(t);
  writeFileSync(join(assets, 'escape.gltf'), gltf('../secret/secret.bin'));
  writeFileSync(join(assets, 'linked.gltf'), gltf('link/secret.bin'));
  const { manifest } = await build({ input: assets, outDir: join(dir, 'out'), sharp: false, ffmpeg: false });
  for (const source of ['escape.gltf', 'linked.gltf']) {
    const entry = manifest.files.find((f) => f.source === source);
    assert.equal(entry.status, 'failed', source);
    assert.match(entry.notes.join('\n'), /outside the model's folder/);
    assert.equal(entry.sourceSha256, sha256(readFileSync(join(assets, source))), 'outside bytes were not hashed');
  }
  assert.ok(existsSync(join(secret, 'secret.bin')));
});

test('a manifest naming outputs outside the output folder is damaged: nothing it names is deleted (bug 42 c)', async (t) => {
  const { dir, assets } = workspace(t);
  const out = join(dir, 'out'),
    victim = join(dir, 'victim.txt'),
    text = 'do not delete';
  writeFileSync(join(assets, 'scene.gltf'), gltf('tri.bin'));
  const first = await build({ input: assets, outDir: out, sharp: false, ffmpeg: false });
  assert.equal(first.manifest.files.find((f) => f.source === 'scene.gltf').status, 'built');
  for (const path of ['../victim.txt', victim, victim.replace(/\\/g, '/'), 'link/../../victim.txt']) {
    writeFileSync(victim, text);
    const manifest = JSON.parse(readFileSync(join(out, 'margo-manifest.json'), 'utf8'));
    // An input that is gone, whose recorded output (with the right hash) the stale-output cleanup would delete.
    manifest.files.push({
      ...manifest.files[0],
      source: 'gone.glb',
      outputs: [{ path, bytes: text.length, sha256: sha256(text) }],
    });
    writeFileSync(join(out, 'margo-manifest.json'), JSON.stringify(manifest));
    const again = await build({ input: assets, outDir: out, sharp: false, ffmpeg: false });
    assert.equal(readFileSync(victim, 'utf8'), text, `${path} was deleted`);
    // The whole manifest is distrusted, so the valid entry is rebuilt, not served from the cache.
    assert.equal(again.manifest.files.find((f) => f.source === 'scene.gltf').status, 'built', path);
  }
  // An intact manifest still caches.
  const cached = await build({ input: assets, outDir: out, sharp: false, ffmpeg: false });
  assert.equal(cached.manifest.files.find((f) => f.source === 'scene.gltf').status, 'cached');
});

test('sameFile and the CLI refuse an output that aliases the input (bug 47)', (t) => {
  const { dir, assets } = workspace(t);
  const input = join(assets, 'part.glb'),
    body = 'glTF; not converted';
  writeFileSync(input, body);
  linkSync(input, join(dir, 'hard.glb'));
  symlinkSync(assets, join(dir, 'via'), 'junction');
  const upper = join(assets, 'PART.GLB'),
    caseInsensitive = existsSync(upper);
  const aliases = [
    ['./part.glb', true],
    ['sub/../part.glb', true],
    [join(dir, 'hard.glb'), true],
    [join(dir, 'via', 'part.glb'), true],
    ['PART.GLB', caseInsensitive],
    ['other.glb', false],
  ];
  for (const [alias, same] of aliases)
    assert.equal(sameFile(join(assets, 'part.glb'), resolve(assets, alias)), same, alias);
  const run = (cli, args) => {
    try {
      execFileSync(process.execPath, [join(root, cli), ...args], { cwd: assets, stdio: 'pipe', timeout: 60_000 });
      return { code: 0, err: '' };
    } catch (error) {
      return { code: error.status, err: String(error.stderr) };
    }
  };
  for (const [alias, same] of aliases.filter(([, same]) => same))
    for (const cli of [['tools/margo-convert/cli.js', 'optimize']]) {
      const result = run(cli[0], [...cli.slice(1), 'part.glb', alias]);
      assert.equal(result.code, 1, `${cli.join(' ')} part.glb ${alias}`);
      assert.match(result.err, /output would overwrite the input; choose another output path/);
      assert.equal(readFileSync(input, 'utf8'), body, `${alias} overwrote the input`);
      assert.ok(same);
    }
});
