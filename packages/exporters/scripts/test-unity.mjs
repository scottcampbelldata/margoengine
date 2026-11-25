// npm run test:unity (opt-in): runs the com.margo.mesh Unity companion in a batch-mode Unity Editor and checks that
// every saved asset's main object is named after its file, that a forced reimport changes no saved file or .meta,
// and that IsCurrent stays true. It skips with a printed reason when no Unity Editor or no licence is found
// (MARGO_UNITY_REQUIRED=1 turns a skip into a failure). Unity runs directly with a hard time limit.
//
// MARGO_UNITY_EDITOR   path to the Unity Editor executable; otherwise the Unity Hub default install of the version
//                      the companion's package.json names
// MARGO_UNITY_PACKAGES folder holding com.unity.cloud.gltfast (and its dependencies) to embed instead of letting
//                      Unity's package manager fetch glTFast from the Unity registry
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { killChildTreeSync } from '../../../scripts/support/shutdown.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, '..');
export const LIMIT_MINUTES = 20;
export const GLTFAST = '6.20.0';
export const SOURCE = 'Assets/Margo/Ranger/model.glb';

/** The Unity Editor version the companion accepts, from its package manifest (`unity` + `unityRelease`). */
export async function companionUnityVersion() {
  const manifest = JSON.parse(await readFile(path.join(pkg, 'src/unity/package.json'), 'utf8'));
  return `${manifest.unity}.${manifest.unityRelease}`;
}

/** Candidate Unity Editor executables: MARGO_UNITY_EDITOR alone when set, else the Unity Hub default install. */
export function unityCandidates({ env = process.env, platform = process.platform, version, home = homedir() } = {}) {
  if (env.MARGO_UNITY_EDITOR) return [env.MARGO_UNITY_EDITOR];
  if (platform === 'win32')
    return [
      path.win32.join(
        env.ProgramFiles || 'C:\\Program Files',
        'Unity',
        'Hub',
        'Editor',
        version,
        'Editor',
        'Unity.exe',
      ),
    ];
  if (platform === 'darwin') return [`/Applications/Unity/Hub/Editor/${version}/Unity.app/Contents/MacOS/Unity`];
  return [path.posix.join(home, 'Unity', 'Hub', 'Editor', version, 'Editor', 'Unity')];
}

/** Why the run did not reach the check: a missing licence is a skip, anything else is a failure. */
export function classifyExit({ code, log = '', timedOut = false }) {
  if (timedOut) return { state: 'fail', reason: `Unity did not finish within ${LIMIT_MINUTES} minutes` };
  if (code === 198 || /No valid Unity Editor license/i.test(log))
    return {
      state: 'skip',
      reason:
        'Unity started but found no valid Editor licence (exit 198); activate one in Unity Hub > Preferences > Licenses',
    };
  if (code !== 0) return { state: 'fail', reason: `Unity exited with code ${code}` };
  return { state: 'ok' };
}

/** Problems in the NameCheck.cs result; an empty list is a pass. */
export function judge(text) {
  // File.WriteAllText keeps StringBuilder.AppendLine's Environment.NewLine, CRLF on Windows.
  const rows = text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split('\t'));
  const problems = [];
  const current = Object.fromEntries(rows.filter((r) => r[0] === 'CURRENT').map((r) => [r[1], r[2]]));
  if (current.BEFORE !== 'True')
    problems.push(
      `the companion did not generate a current import: ${
        rows
          .find((r) => r[0] === 'CURRENT')
          ?.slice(2)
          .join(' ') ?? 'no result'
      }`,
    );
  if (current.BEFORE === 'True' && current.AFTER !== 'True')
    problems.push('IsCurrent turned false after the forced reimport');
  for (const r of rows.filter((r) => r[0] === 'WARNING')) problems.push(`Unity warned: ${r[1]}`);
  const assets = { BEFORE: new Map(), AFTER: new Map() };
  for (const [, label, file, type, name, base, sha, meta] of rows.filter((r) => r[0] === 'ASSET')) {
    assets[label].set(file, { type, name, sha, meta });
    if (name !== base) problems.push(`${label}: ${file} (${type}) main object is named ${name}, not ${base}`);
  }
  if (current.BEFORE === 'True') {
    for (const [type, file] of [
      ['Mesh', 'Mesh_0_0.asset'],
      ['AnimationClip', 'Animation_0.anim'],
    ])
      if (![...assets.BEFORE].some(([p, a]) => p.endsWith('/' + file) && a.type === type))
        problems.push(`no saved ${type} ${file}`);
    for (const [file, a] of assets.BEFORE) {
      const b = assets.AFTER.get(file);
      if (!b) problems.push(`${file} is missing after the reimport`);
      else if (b.sha !== a.sha || b.meta !== a.meta)
        problems.push(`${file} or its .meta changed on the forced reimport`);
    }
    const states = rows.filter((r) => r[0] === 'STATE' && r[1] === 'BEFORE').map((r) => `${r[2]}>${r[3]}`);
    if (states.join() !== 'Walk-loop>Animation_0')
      problems.push(`controller states are ${states.join() || 'none'}, not Walk-loop playing Animation_0`);
  }
  return problems;
}

/** The one-mesh, one-clip ranger bundle (mesh Art, clip Walk-loop: names that differ from the generated files). */
async function writeProject(project) {
  const dist = pathToFileURL(path.join(pkg, 'dist') + path.sep).href;
  const { exportGLB, paletteTexture } = await import(dist + 'index.js');
  const { createUnityImportBundle, createUnityImportSupportPackage } = await import(dist + 'unity.js');
  const geometry = {
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    uvs: [0, 0, 1, 0, 0, 1, 1, 1],
    indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
  };
  const texture = (await paletteTexture([12, 34, 56, 255, 91, 71, 33, 0])).texture;
  const art = { name: 'Art', geometry, material: { baseColorTexture: texture }, extras: { id: 'art' } };
  const scene = {
    nodes: [art],
    animations: [
      {
        name: 'Walk-loop',
        extras: { fps: 12, loop: true },
        channels: [
          {
            node: art,
            path: 'translation',
            interpolation: 'STEP',
            times: [0, 1 / 12, 2 / 12],
            values: [0, 0, 0, 1, 0, 0, 0, 0, 0],
          },
        ],
      },
    ],
  };
  const glb = exportGLB(scene, { generator: 'Margo Mesh Studio' });
  const write = async (entries) => {
    for (const e of entries) {
      const target = path.join(project, e.name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, e.data);
    }
  };
  await write((await createUnityImportSupportPackage()).entries);
  await write((await createUnityImportBundle(glb, { folder: 'Assets/Margo/Ranger' })).entries);
  const dependencies = { 'com.unity.cloud.gltfast': GLTFAST };
  for (const m of [
    'animation',
    'imageconversion',
    'imgui',
    'jsonserialize',
    'physics',
    'unitywebrequest',
    'unitywebrequesttexture',
  ])
    dependencies[`com.unity.modules.${m}`] = '1.0.0';
  await mkdir(path.join(project, 'Packages'), { recursive: true });
  await writeFile(path.join(project, 'Packages/manifest.json'), JSON.stringify({ dependencies }, null, 2) + '\n');
  if (process.env.MARGO_UNITY_PACKAGES)
    for (const name of readdirSync(process.env.MARGO_UNITY_PACKAGES).filter((n) => n.startsWith('com.unity.')))
      await cp(path.join(process.env.MARGO_UNITY_PACKAGES, name), path.join(project, 'Packages', name), {
        recursive: true,
      });
  await mkdir(path.join(project, 'Assets/Editor'), { recursive: true });
  for (const name of ['NameCheck.cs', 'MargoCheck.asmdef'])
    await cp(path.join(pkg, 'tests/unity', name), path.join(project, 'Assets/Editor', name));
  await mkdir(path.join(project, 'ProjectSettings'), { recursive: true });
  await writeFile(
    path.join(project, 'ProjectSettings/ProjectVersion.txt'),
    `m_EditorVersion: ${await companionUnityVersion()}\n`,
  );
}

/**
 * Removes the temporary project folder. Nothing may hold a file in it by now: runUnity has ended every process the
 * Editor started (KB-UNITY-RM1: on Windows the Package Manager server, the licensing client and the shared compiler
 * outlive the Editor, parented to its dead pid, and the Package Manager server holds Logs/upm.log in the project).
 * A failure to remove is a real error and is thrown.
 */
export async function removeWorkDir(dir, remove = rm) {
  await remove(dir, { recursive: true, force: true });
}

/**
 * The processes the Editor left behind: every process in `rows` ({ pid, ppid, created }) whose parent chain reaches
 * `rootPid` through processes created at or after `since` (ms). A dead parent's pid stays on its orphans, and the
 * creation time rules out an unrelated process that was later given the same pid.
 */
export function orphansOf(rows, rootPid, since) {
  const found = [];
  const parents = new Set([rootPid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows)
      if (parents.has(r.ppid) && r.created >= since && !parents.has(r.pid) && r.pid !== process.pid) {
        parents.add(r.pid);
        found.push(r.pid);
        grew = true;
      }
  }
  return found;
}

/** Every running process as { pid, ppid, created } (Windows only; created in ms since the epoch). */
function listProcesses() {
  const script =
    'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; created = [double]([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } } | ConvertTo-Json -Compress';
  const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (out.status !== 0) throw new Error(`test:unity: could not list processes: ${out.stderr || out.error}`);
  const rows = JSON.parse(out.stdout);
  return Array.isArray(rows) ? rows : [rows];
}

/** Ends what the exited Editor left running, and returns once those processes are gone. */
export function endOrphans(rootPid, since) {
  if (process.platform !== 'win32') return [];
  const rows = listProcesses(),
    pids = orphansOf(rows, rootPid, since),
    created = new Map(rows.map((r) => [r.pid, r.created]));
  // Orphans are not below this process, so each is ended through a handle opened by pid and only when its start time is
  // still the one listed: a pid freed since the listing may be another process's by now (KB-TEST-FILEEXIT1).
  if (pids.length)
    spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        pids
          .map(
            (pid) =>
              `try { $p = [Diagnostics.Process]::GetProcessById(${pid}); if (([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() -eq ${created.get(pid)}) { $p.Kill() } } catch [ArgumentException] {} catch [InvalidOperationException] {} catch [ComponentModel.Win32Exception] {}`,
          )
          .join('\n'),
      ],
      { stdio: 'ignore', windowsHide: true },
    );
  const alive = () =>
    new Set(
      listProcesses()
        .filter((r) => created.get(r.pid) === r.created)
        .map((r) => r.pid),
    );
  const deadline = Date.now() + 30_000;
  for (let now = alive(); pids.some((p) => now.has(p)); now = alive())
    if (Date.now() > deadline) throw new Error(`test:unity: could not end Unity child processes ${pids.join(', ')}`);
  return pids;
}

/** Kills the whole process tree of the child. */
function killTree(child) {
  if (process.platform === 'win32') killChildTreeSync(child);
  else
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
}

function runUnity(unity, args) {
  return new Promise((resolve) => {
    const since = Date.now();
    const child = spawn(unity, args, { stdio: 'inherit', windowsHide: true, detached: process.platform !== 'win32' });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, LIMIT_MINUTES * 60_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      endOrphans(child.pid, since);
      resolve({ code, timedOut });
    });
  });
}

async function main() {
  const required = process.env.MARGO_UNITY_REQUIRED === '1';
  const skip = (reason) => {
    console.error(`test:unity SKIPPED: ${reason}. Nothing was checked.`);
    process.exitCode = required ? 1 : 0;
  };
  const version = await companionUnityVersion();
  const unity = unityCandidates({ version }).find((p) => existsSync(p));
  if (!unity)
    return skip(`no Unity ${version} Editor found (set MARGO_UNITY_EDITOR or install ${version} through Unity Hub)`);
  const work = await mkdtemp(path.join(tmpdir(), 'margo-unity-'));
  const project = path.join(work, 'proj');
  const logFile = path.join(work, 'unity.log');
  const resultFile = path.join(work, 'result.txt');
  await writeProject(project);
  console.log(`test:unity: ${unity}\n  project ${project}`);
  const run = await runUnity(unity, [
    '-batchmode',
    '-nographics',
    '-projectPath',
    project,
    '-executeMethod',
    'MargoCheck.NameCheck.Run',
    '-margoResult',
    resultFile,
    '-logFile',
    logFile,
  ]);
  const log = existsSync(logFile) ? await readFile(logFile, 'utf8') : '';
  const exit = classifyExit({ ...run, log });
  if (exit.state === 'skip') {
    await removeWorkDir(work);
    return skip(exit.reason);
  }
  const problems =
    exit.state === 'fail' ? [exit.reason] : judge(existsSync(resultFile) ? await readFile(resultFile, 'utf8') : '');
  if (problems.length) {
    console.error(`test:unity FAILED (log ${logFile}, result ${resultFile}):\n- ${problems.join('\n- ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `test:unity passed: ${(await readFile(resultFile, 'utf8')).split('\n').filter((l) => l.startsWith('ASSET\tBEFORE')).length} saved assets keep their file names through a forced reimport; IsCurrent stays true`,
  );
  await removeWorkDir(work);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
