// The Unity companion names each saved native asset's main object after its file, and the opt-in batch-mode check
// (npm run test:unity, scripts/test-unity.mjs) judges a real Unity run. The two result files are real Unity 6000.6.7f1
// runs of tests/unity/NameCheck.cs on 2026-11-15: com.margo.mesh 0.3.0 before the fix, and after it.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { classifyExit, endOrphans, judge, orphansOf, removeWorkDir, unityCandidates } from '../scripts/test-unity.mjs';

const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');
const script = new URL('../scripts/test-unity.mjs', import.meta.url);

test('the companion saves each native asset main object under its file name and keeps the glTF clip name on the state', async () => {
  const resources = await read('../src/unity/Editor/ImportCompanion.Resources.cs');
  const animation = await read('../src/unity/Editor/ImportCompanion.Animation.cs');
  const save = resources.slice(resources.indexOf('static T Save<T>'), resources.indexOf('static Mesh MeshFor'));
  // Unity warns "Main Object Name ... does not match filename" for a single-object native asset named otherwise.
  assert.match(save, /string displayName = MainObjectName\(name\);/);
  assert.doesNotMatch(save, /displayName = value\.name/);
  assert.match(
    resources,
    /static string MainObjectName\(string file\) => System\.IO\.Path\.GetFileNameWithoutExtension\(file\);/,
  );
  assert.match(resources, /clip\.name == MainObjectName\(ClipFile\(i\)\)/);
  // The controller state, the name Animator.Play takes, keeps the ordered glTF clip identity.
  assert.match(animation, /CreateState\(machine, owner\.clipIdentities\[i\]\.name, i\)/);
  assert.doesNotMatch(animation, /AddState\(clip\.name/);
});

test('the Unity check fails the 0.3.0 run on its mismatched names and passes the fixed run', async () => {
  const before = await read('unity/result-0.3.0-before-fix.txt');
  const fixed = await read('unity/result-fixed.txt');
  const problems = judge(before);
  assert.ok(
    problems.includes(
      'BEFORE: Assets/Margo/Ranger/model.Margo/Mesh_0_0.asset (Mesh) main object is named Art(Clone), not Mesh_0_0',
    ),
    problems.join('\n'),
  );
  assert.ok(
    problems.includes(
      'AFTER: Assets/Margo/Ranger/model.Margo/Animation_0.anim (AnimationClip) main object is named Walk-loop, not Animation_0',
    ),
  );
  assert.ok(problems.some((p) => p.startsWith("Unity warned: Main Object Name 'Walk-loop'")));
  assert.deepEqual(judge(fixed), []);
  // NameCheck.cs writes Environment.NewLine, CRLF on Windows: the same rows pass either way.
  assert.deepEqual(judge(fixed.replace(/\r?\n/g, '\r\n')), []);
  assert.deepEqual(judge(fixed.replace(/\r?\n/g, '\n')), []);
});

test('the Unity check fails a changed file, a lost IsCurrent, a missing clip and an empty result', async () => {
  const fixed = (await read('unity/result-fixed.txt')).replace(/\r?\n/g, '\n');
  const lines = fixed.split('\n');
  const changed = lines
    .map((l) =>
      l.startsWith('ASSET\tAFTER') && l.includes('Mesh_0_0')
        ? l.replace(/\t[0-9A-F]{64}\t/, '\t' + '0'.repeat(64) + '\t')
        : l,
    )
    .join('\n');
  assert.deepEqual(judge(changed), [
    'Assets/Margo/Ranger/model.Margo/Mesh_0_0.asset or its .meta changed on the forced reimport',
  ]);
  assert.deepEqual(judge(fixed.replace('CURRENT\tAFTER\tTrue', 'CURRENT\tAFTER\tFalse')), [
    'IsCurrent turned false after the forced reimport',
  ]);
  const noClip = lines.filter((l) => !l.includes('Animation_0.anim')).join('\n');
  assert.ok(judge(noClip).includes('no saved AnimationClip Animation_0.anim'));
  assert.equal(judge('').length, 1);
});

test('a missing Unity licence is a skip; any other exit or a timeout fails', () => {
  assert.equal(classifyExit({ code: 198 }).state, 'skip');
  assert.equal(
    classifyExit({ code: 1, log: 'No valid Unity Editor license found. Please activate your license.' }).state,
    'skip',
  );
  assert.equal(classifyExit({ code: 1 }).state, 'fail');
  assert.equal(classifyExit({ code: 0, timedOut: true }).state, 'fail');
  assert.equal(classifyExit({ code: 0 }).state, 'ok');
});

test('the Unity Editor comes from MARGO_UNITY_EDITOR or the Unity Hub default install of the accepted version', () => {
  assert.deepEqual(
    unityCandidates({ env: { MARGO_UNITY_EDITOR: '/opt/u/Unity' }, platform: 'linux', version: '6000.6.7f1' }),
    ['/opt/u/Unity'],
  );
  assert.deepEqual(unityCandidates({ env: { ProgramFiles: 'D:\\Apps' }, platform: 'win32', version: '6000.6.7f1' }), [
    'D:\\Apps\\Unity\\Hub\\Editor\\6000.6.7f1\\Editor\\Unity.exe',
  ]);
  assert.deepEqual(unityCandidates({ env: {}, platform: 'darwin', version: '6000.6.7f1' }), [
    '/Applications/Unity/Hub/Editor/6000.6.7f1/Unity.app/Contents/MacOS/Unity',
  ]);
  assert.deepEqual(unityCandidates({ env: {}, platform: 'linux', version: '6000.6.7f1', home: '/h' }), [
    '/h/Unity/Hub/Editor/6000.6.7f1/Editor/Unity',
  ]);
});

test('with no Unity Editor the check prints a skip, and MARGO_UNITY_REQUIRED=1 makes that a failure', async () => {
  const env = { ...process.env, MARGO_UNITY_EDITOR: fileURLToPath(new URL('./unity/no-such-editor', import.meta.url)) };
  const run = (extra) =>
    promisify(execFile)(process.execPath, [fileURLToPath(script)], {
      env: { ...env, ...extra },
      timeout: 30_000,
      windowsHide: true,
    });
  const skipped = await run({ MARGO_UNITY_REQUIRED: '0' });
  assert.match(skipped.stderr, /test:unity SKIPPED: no Unity 6000\.6\.7f1 Editor found.*Nothing was checked\./);
  await assert.rejects(run({ MARGO_UNITY_REQUIRED: '1' }), (e) => e.code === 1 && /SKIPPED/.test(e.stderr));
});

test('removal makes no retry and swallows nothing: a busy folder is an error (KB-UNITY-RM1)', async () => {
  const calls = [];
  await assert.rejects(
    removeWorkDir('work-dir', async (dir, options) => {
      calls.push(options);
      throw Object.assign(new Error('EBUSY: resource busy or locked, unlink'), { code: 'EBUSY' });
    }),
    { code: 'EBUSY' },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].maxRetries, undefined);
});

test('orphansOf follows the dead Editor pid through its children, skipping older processes that reuse a pid (KB-UNITY-RM1)', () => {
  const rows = [
    { pid: 10, ppid: 1, created: 50 },
    { pid: 11, ppid: 10, created: 100 },
    { pid: 12, ppid: 11, created: 120 },
    { pid: 13, ppid: 10, created: 20 },
    { pid: 14, ppid: 99, created: 130 },
  ];
  assert.deepEqual(orphansOf(rows, 10, 100).sort(), [11, 12]);
});

test('endOrphans ends a process the exited parent left running in the folder, so removal then succeeds first time (KB-UNITY-RM1)', {
  skip: process.platform !== 'win32',
}, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'margo-orphan-'));
  // A detached child of a parent that exits keeps running, like Unity's Package Manager server; its working
  // folder cannot be removed while it runs.
  const parent = `require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: process.env.HELD, stdio: 'ignore', windowsHide: true, detached: true }).unref();`;
  const since = Date.now();
  const run = spawn(process.execPath, ['-e', parent], {
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, HELD: dir },
  });
  await new Promise((resolve) => run.on('exit', resolve));
  await assert.rejects(rm(dir, { recursive: true, force: true }), { code: /EBUSY|EPERM/ });
  assert.equal(endOrphans(run.pid, since).length, 1);
  await removeWorkDir(dir);
  assert.equal(existsSync(dir), false);
});
