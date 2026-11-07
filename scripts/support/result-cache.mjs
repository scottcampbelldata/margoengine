// The content-keyed result cache for checks (private plan: small-change-check-plan.md, phase 1, shadow mode). The same
// test on the same bytes is the same result, so a step's key is the SHA-256 of everything it really read (recorded by
// scripts/support/record-reads.mjs) plus the machine facts. In this phase every step still runs: the store only answers
// "would this have hit?", and a run that fails on a key holding a pass poisons the key and writes the pair to the
// disagreement ledger. MARGO_RESULT_CACHE_SERVE asks for serving, which this phase does not have; it changes nothing.
//
// Store: %LOCALAPPDATA%\margoengine\result-cache (shared by every worktree on this PC, the point of the store), 5 GB
// cap, oldest out. Paths in keys are relative to the repository, so two worktrees with the same bytes share keys.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, release } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { margoError } from '../../packages/shared/errors.js';
import { packageClosure, packageDependencies } from '../package-order.js';
import { isClockInfrastructure, READ_RANK } from './record-reads.mjs';

export const CAP_BYTES = 5 * 1024 ** 3;
/** Stored passes kept per step; the newest are the ones a tree can still match. */
const CANDIDATES_PER_STEP = 8;
/** Bump when the recorder or the meaning of a key changes: every old entry then misses, with no false disagreement. */
const KEY_VERSION = 3;

/**
 * Paths excluded from keys, each with the reason. Everything else a step reads is an input or refuses the step.
 */
export const EXCLUDED_PATHS = [
  [/^test-results\/gpu[^/]*\.lock(\/|$)/, 'the GPU lock folder is coordination between processes, not an input'],
  [
    /^node_modules\/\.vite[^/]*(\/|$)/,
    'per-server Vite caches hold derived copies of inputs that are hashed themselves',
  ],
  [/^node_modules\/\.cache(\/|$)/, 'tool caches hold derived copies of inputs that are hashed themselves'],
  [/^node_modules\/\.bin(\/|$)/, 'bin shims follow from the lock file, which is hashed through each package entry'],
  [
    /^node_modules\/\.modules\.yaml$/,
    "Vite's probe for pnpm's marker, made only on some paths; this repository uses npm",
  ],
  [/^\.git$/, 'a worktree link names this folder; what a step asks git is keyed by the command and its output'],
];

/** Native programs a recorded step may start without losing its key, each with the reason. */
export const ALLOWED_PROGRAMS = new Map([
  ['net', 'Vite asks Windows for mapped network drives, which only spells a path another way'],
  ['taskkill', 'ends processes, reads nothing a result depends on'],
]);

/**
 * Native code that reads files where the recorder cannot see: bundlers loaded into the process, and the linter. A scope
 * that uses one keys on the whole committed tree except documents, and on every package's dist, unless the caller
 * declares narrower inputs. A one-line code change then misses it, which is the safe side; a docs line still hits.
 */
const NATIVE_READERS = /^(node_modules\/(@rolldown\/[^@]+|rolldown|esbuild|@esbuild\/[^@]+|@biomejs\/[^@]+))@/;
const NATIVE_PROGRAMS = new Set(['biome', 'esbuild']);
const TREE_WITHOUT_DOCS = '^(?!docs/|private/|.*\\.md$)';

/** git subcommands that only read; anything else in the repository makes a step uncacheable. */
const GIT_READ_ONLY = new Set([
  'rev-parse',
  'status',
  'ls-files',
  'diff',
  'log',
  'show',
  'merge-base',
  'cat-file',
  'ls-tree',
  'describe',
  'check-ignore',
  'check-attr',
  'grep',
  'config',
  'symbolic-ref',
  'for-each-ref',
  'branch',
]);

/**
 * Test files that time real work: wall-clock results stay uncached (plan D5). The files that call Date.now or
 * Math.random from test code are found by the recorder and need no list.
 */
export const WALL_CLOCK_TESTS = new Set(['check-wall-budgets.test.js', 'cpu-budget.test.js']);

/** The store folder: a Windows per-user folder, or the home cache elsewhere. */
export function defaultStoreDir(env = process.env) {
  return env.LOCALAPPDATA
    ? join(env.LOCALAPPDATA, 'margoengine', 'result-cache')
    : join(homedir(), '.cache', 'margoengine', 'result-cache');
}

/** Shadow mode runs on a developer machine; CI has no store that outlives the run. `MARGO_RESULT_CACHE=off` stops it. */
export function shadowEnabled(env = process.env) {
  return env.MARGO_RESULT_CACHE !== 'off' && !env.CI;
}

/** Whether serving was asked for. Phase 1 has no serving: nothing reads this to skip a step, and the log says so. */
export function servingRequested(env = process.env) {
  return env.MARGO_RESULT_CACHE_SERVE === '1';
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const posix = (path) => (sep === '\\' ? path.replaceAll('\\', '/') : path);

/** The key: SHA-256 of the step, the sorted inputs and the machine facts. The same bytes always give the same key. */
export function computeKey(step, inputs, facts) {
  const sorted = [...inputs].map((row) => JSON.stringify(row)).sort();
  return sha256(JSON.stringify([KEY_VERSION, step, sorted, Object.entries(facts).sort()]));
}

/** Node, npm, OS build and machine profile name: every step gets these. */
export function machineFacts(env = process.env) {
  const npmManifest = join(dirname(process.execPath), 'node_modules', 'npm', 'package.json');
  return {
    keyVersion: KEY_VERSION,
    node: process.version,
    npm: existsSync(npmManifest) ? JSON.parse(readFileSync(npmManifest, 'utf8')).version : 'unknown',
    os: `${process.platform} ${release()}`,
    profile: env.MARGO_MACHINE_PROFILE ?? 'default',
  };
}

/**
 * What the repository knows about its files: tracked, changed and LFS state, and the lock file's package entries. Built
 * once per run; a test passes its own.
 */
export function readRepository(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 256 * 1024 ** 2 }).toString();
  const tracked = new Set(git('ls-files', '-z').split('\0').filter(Boolean));
  const dirty = new Set(
    git('status', '--porcelain', '-z', '--no-renames', '--untracked-files=no')
      .split('\0')
      .filter(Boolean)
      .map((row) => row.slice(3)),
  );
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages;
  const stage = git('ls-files', '-s', '-z').split('\0').filter(Boolean);
  return { root: resolve(root), tracked, dirty, lock, stage };
}

/** The hash of the committed blobs whose path matches `pattern`; a dirty match answers with a marker that never holds. */
function treeValue(pattern, repository, memo = new Map()) {
  let value = memo.get(pattern);
  if (value === undefined) {
    const match = new RegExp(pattern),
      rows = (repository.stage ?? []).filter((row) => match.test(row.slice(row.indexOf('\t') + 1)));
    value = sha256(rows.join('\n'));
    memo.set(pattern, value);
  }
  return value;
}

/** The hash of every package's dist folder, once per run. */
function allDistValue(context) {
  if (context.memo.allDist === undefined) {
    const packages = join(context.repository.root, 'packages'),
      rows = readdirSync(packages)
        .sort()
        .filter((name) => existsSync(join(packages, name, 'dist')))
        .map((name) => `${name} ${hashFolder(join(packages, name, 'dist'))}`);
    context.memo.allDist = sha256(rows.join('\n'));
  }
  return context.memo.allDist;
}

/** The hash of one package's dist folder, once per run. */
function distValue(name, context) {
  context.memo.dists ??= new Map();
  let value = context.memo.dists.get(name);
  if (value === undefined) {
    const folder = join(context.repository.root, 'packages', name, 'dist');
    value = existsSync(folder) ? hashFolder(folder) : 'absent';
    context.memo.dists.set(name, value);
  }
  return value;
}

/** Directory name of every workspace package to its parsed package.json. */
function readManifests(root) {
  const packages = join(root, 'packages');
  if (!existsSync(packages)) return new Map();
  return new Map(
    readdirSync(packages)
      .filter((name) => existsSync(join(packages, name, 'package.json')))
      .map((name) => [name, JSON.parse(readFileSync(join(packages, name, 'package.json'), 'utf8'))]),
  );
}

/** Maps a path into the node_modules of the lock file; returns `{ lock }` for a package, `{ path }` otherwise. */
function placeNodeModules(path, repository) {
  const at = path.indexOf('node_modules/');
  if (at < 0) return undefined;
  const parts = path.slice(at).split('/');
  // The deepest package folder this path is inside: node_modules/a/node_modules/@b/c/... -> that prefix.
  let deepest = -1;
  for (let index = 0; index < parts.length; index++) if (parts[index] === 'node_modules') deepest = index;
  const nameEnd = parts[deepest + 1]?.startsWith('@') ? deepest + 3 : deepest + 2,
    key = parts.slice(0, nameEnd).join('/'),
    rest = parts.slice(nameEnd).join('/');
  const entry = repository.lock[at > 0 && repository.lock[path.slice(0, at) + key] ? path.slice(0, at) + key : key];
  if (!entry) return { path: path.slice(at) };
  if (entry.link) return { linked: rest ? `${entry.resolved}/${rest}` : entry.resolved };
  return { lock: `${key}@${entry.version ?? ''} ${entry.integrity ?? ''}` };
}

/** Hashes files once per run. */
class Hasher {
  #memo = new Map();
  value(kind, absolute) {
    const memoKey = `${kind}\0${absolute}`;
    let found = this.#memo.get(memoKey);
    if (found !== undefined) return found;
    found = this.#read(kind, absolute);
    this.#memo.set(memoKey, found);
    return found;
  }
  #read(kind, absolute) {
    const stat = statSync(absolute, { throwIfNoEntry: false });
    if (!stat) return 'absent';
    if (stat.isDirectory())
      return kind === 'd' ? `listing ${sha256(readdirSync(absolute).sort().join('\n'))}` : 'folder';
    return kind === 'e' ? 'present' : `file ${sha256(readFileSync(absolute))}`;
  }
  /** A step wrote this path: the next read sees the new bytes. */
  forget(absolute) {
    for (const kind of ['r', 'd', 'e']) this.#memo.delete(`${kind}\0${absolute}`);
  }
}

/** Two reads of one path: the strongest kind stands, at the first time it happened. */
function mergeRead(had, kind, at) {
  const rank = READ_RANK[kind] - READ_RANK[had[0]];
  if (rank > 0) {
    had[0] = kind;
    had[1] = at;
  } else if (rank === 0) had[1] = Math.min(had[1], at);
}

/** Reads the logs of one recorded step and merges them per scope (a test file, a package build, or '' for the step). */
export function collectLogs(dir) {
  const scopes = new Map();
  const scopeOf = (name) => {
    let found = scopes.get(name);
    if (!found) {
      found = {
        name,
        reads: new Map(),
        writes: new Map(),
        covers: new Set(),
        env: new Map(),
        git: new Map(),
        opaque: new Set(),
        net: new Set(),
        clocks: new Map(),
        exitCode: undefined,
        seconds: 0,
        incomplete: false,
      };
      scopes.set(name, found);
    }
    return found;
  };
  if (!existsSync(dir)) return { scopes, order: [] };
  const started = readFileSync(join(dir, 'starts.log'), 'utf8').split('\n').filter(Boolean),
    order = [];
  for (const line of started) {
    const [name, startScope] = line.split('\t'),
      file = join(dir, `${name}.json`);
    if (!existsSync(file)) {
      // Killed before it could write its log: what it read is unknown.
      scopeOf(startScope).incomplete = true;
      continue;
    }
    const log = JSON.parse(readFileSync(file, 'utf8'));
    for (const part of log.segments) {
      const scope = scopeOf(part.scope);
      if (!order.includes(part.scope)) order.push(part.scope);
      for (const [path, [kind, at]] of part.reads) {
        const had = scope.reads.get(path);
        if (!had) scope.reads.set(path, [kind, at]);
        else mergeRead(had, kind, at);
      }
      for (const [path, at] of part.writes) scope.writes.set(path, Math.min(at, scope.writes.get(path) ?? at));
      for (const path of part.covers) scope.covers.add(path);
      for (const [key, value] of part.env) if (!scope.env.has(key)) scope.env.set(key, value);
      for (const [args, cwd] of part.git) scope.git.set(JSON.stringify([args, cwd]), [args, cwd]);
      for (const program of part.opaque) scope.opaque.add(program);
      for (const host of part.net) scope.net.add(host);
      for (const [file_, what] of part.clocks) scope.clocks.set(file_, what);
      if (log.lead) {
        scope.exitCode = log.exitCode;
        scope.seconds = part.seconds;
      }
    }
  }
  return { scopes, order };
}

/**
 * Turns one scope's record into key inputs. `refused` holds a reason for every thing that makes the scope unfit to cache:
 * a read of a file that is not tracked, committed and real, a mutated input, an unknown native program, the network, a
 * nondeterministic call. A refused scope still runs and reports why; it is simply never stored.
 */
export function buildManifest(record, context) {
  const { repository, hasher, outputs, base, declared, builtOn } = context,
    root = repository.root;
  context.memo ??= {};
  context.memo.trees ??= new Map();
  const inputs = new Map(),
    refused = new Set(),
    writesHere = new Set([...record.writes.keys(), ...(base?.writes.keys() ?? [])]);
  const covers = [...record.covers, ...(base?.covers ?? [])].map((path) => `${path}${sep}`);
  const firstWrite = (path) => Math.min(record.writes.get(path) ?? Infinity, base?.writes.get(path) ?? Infinity);
  const toRepoPath = (absolute) => {
    const inside = relative(root, absolute);
    return inside.startsWith('..') || resolve(root, inside) !== absolute ? undefined : posix(inside);
  };
  const addRead = (absolute, kind, at) => {
    const own = writesHere.has(absolute) || covers.some((prefix) => absolute.startsWith(prefix));
    const repoPath = toRepoPath(absolute);
    if (own) {
      // Read first and rewritten later means the bytes a key could see are gone. An existence check before a write is
      // the normal way to make an output, and its answer follows from the same step's inputs.
      // A path under a folder the step made has no write of its own and cannot be a rewritten input.
      if (
        (kind === 'r' || kind === 'm') &&
        writesHere.has(absolute) &&
        at < firstWrite(absolute) &&
        !covers.some((prefix) => absolute.startsWith(prefix))
      )
        refused.add(`reads and then rewrites ${repoPath ?? absolute}`);
      return;
    }
    const placed = placeNodeModules(repoPath ?? posix(absolute), repository);
    if (placed?.lock) {
      inputs.set(`lock:${placed.lock}`, ['lock', placed.lock]);
      return;
    }
    if (placed?.linked) return addRead(resolve(root, placed.linked), kind, at);
    const name = placed?.path ?? repoPath;
    if (name === undefined) {
      // Node's own folder is covered by the node and npm machine facts.
      if (absolute.startsWith(`${dirname(process.execPath)}${sep}`)) return;
      // Module resolution and tools walk up past the repository looking for files that are not there: no bytes to key.
      const outside = hasher.value('e', absolute);
      if (outside === 'absent' || outside === 'folder') return;
      refused.add(`reads outside the repository: ${posix(absolute)}`);
      return;
    }
    if (EXCLUDED_PATHS.some(([pattern]) => pattern.test(name))) return;
    const value = hasher.value(kind === 'm' ? 'r' : kind, placed?.path ? resolve(absolute) : resolve(root, name));
    inputs.set(`${kind === 'd' ? 'dir' : kind === 'e' ? 'exists' : 'file'}:${name}`, [
      kind === 'd' ? 'dir' : kind === 'e' ? 'exists' : 'file',
      name,
      value,
    ]);
    if (value === 'absent' || value === 'folder' || value.startsWith('listing')) return;
    if (repository.dirty.has(name)) refused.add(`reads a file with uncommitted changes: ${name}`);
    else if (!repository.tracked.has(name) && !outputs.has(name) && !placed)
      refused.add(`untracked read: ${name} is not tracked and no earlier step of this run wrote it`);
    else if (value.startsWith('file') && repository.tracked.has(name) && isLfsPointer(resolve(root, name)))
      refused.add(`reads an LFS pointer: ${name}; run git lfs checkout`);
    if (kind === 'm') addNearestManifest(absolute, repoPath);
  };
  const seenManifests = new Set();
  const addNearestManifest = (absolute, repoPath) => {
    if (repoPath === undefined) return;
    for (let folder = dirname(absolute); folder.length >= root.length; folder = dirname(folder)) {
      const manifest = join(folder, 'package.json');
      if (seenManifests.has(manifest)) return;
      seenManifests.add(manifest);
      if (existsSync(manifest)) {
        addRead(manifest, 'r', Infinity);
        return;
      }
      if (folder === root) return;
    }
  };
  for (const part of base ? [base, record] : [record]) {
    for (const [absolute, [kind, at]] of part.reads) addRead(absolute, kind, at);
    for (const [key, value] of part.env) {
      const shown = typeof value === 'string' ? value.replaceAll(root, '<root>') : value;
      inputs.set(`env:${key}`, ['env', key, shown]);
    }
    for (const [args, cwd] of part.git.values()) {
      const inside = toRepoPath(cwd);
      if (inside === undefined) continue; // A test's own fixture repository, under its temp folder.
      const subcommand = args.find((word) => !word.startsWith('-'));
      if (!GIT_READ_ONLY.has(subcommand) || (['branch', 'config'].includes(subcommand) && args.length > 3)) {
        refused.add(`runs git ${args.join(' ')}, which may change the repository`);
        continue;
      }
      inputs.set(`git:${inside} ${args.join(' ')}`, ['git', inside, args, replayGit(args, cwd, context)]);
    }
    for (const program of part.opaque)
      if (ALLOWED_PROGRAMS.has(program) || NATIVE_PROGRAMS.has(program))
        inputs.set(`program:${program}`, ['program', program]);
      else refused.add(`starts ${program}, a native program whose reads cannot be recorded`);
    for (const host of part.net) refused.add(`uses the network: ${host}`);
    for (const [file, what] of part.clocks)
      if (!isClockInfrastructure(file))
        refused.add(`nondeterministic: ${toRepoPath(resolve(file)) ?? file} calls ${what}`);
  }
  const addTree = (pattern) =>
    inputs.set(`tree:${pattern}`, ['tree', pattern, treeValue(pattern, repository, context.memo.trees)]);
  const native = [...inputs.values()].some(
    ([kind, name]) =>
      (kind === 'lock' && NATIVE_READERS.test(name)) || (kind === 'program' && NATIVE_PROGRAMS.has(name)),
  );
  for (const name of builtOn ?? []) inputs.set(`dist:${name}`, ['dist', name, distValue(name, context)]);
  if (declared) {
    for (const pattern of declared) addTree(pattern);
  } else if (native) {
    addTree(TREE_WITHOUT_DOCS);
    inputs.set('all-dist', ['all-dist', '', allDistValue(context)]);
  }
  if (native || declared) {
    const treeRows = [...inputs.values()].filter(([kind]) => kind === 'tree').map(([, pattern]) => new RegExp(pattern));
    for (const file of repository.dirty)
      if (treeRows.some((match) => match.test(file))) refused.add(`reads a file with uncommitted changes: ${file}`);
  }
  return { inputs: [...inputs.values()], refused: [...refused].sort() };
}

const lfsMemo = new Map();
function isLfsPointer(absolute) {
  let found = lfsMemo.get(absolute);
  if (found === undefined) {
    const size = statSync(absolute, { throwIfNoEntry: false })?.size ?? 0;
    found =
      size > 0 &&
      size <= 512 &&
      readFileSync(absolute, 'latin1').startsWith('version https://git-lfs.github.com/spec/');
    lfsMemo.set(absolute, found);
  }
  return found;
}

/** The hash of a read-only git command's output, run once per run: the output is what the step depended on. */
function replayGit(args, cwd, context) {
  const memoKey = JSON.stringify([args, cwd]);
  context.git ??= new Map();
  let value = context.git.get(memoKey);
  if (value === undefined) {
    // A command that exits non-zero (a probe for a commit that is not there) is an answer too: status and output both count.
    const { status, stdout } = spawnSync('git', args, {
      cwd,
      maxBuffer: 256 * 1024 ** 2,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    value = `${status} ${sha256(stdout ?? '')}`;
    context.git.set(memoKey, value);
  }
  return value;
}

/**
 * Checks whether a stored manifest still describes this tree: every input re-read gives the stored value. `liveEnv` is
 * the environment the step saw where it read a name; other names are looked up in this process.
 */
export function manifestHolds(entry, context, liveEnv = new Map()) {
  const { hasher, repository } = context,
    root = repository.root;
  for (const row of entry.inputs) {
    const [kind, name] = row;
    if (kind === 'lock') {
      if (!lockHolds(name, repository)) return false;
    } else if (kind === 'env') {
      const live = liveEnv.has(name) ? liveEnv.get(name) : process.env[name];
      const shown = typeof live === 'string' ? live.replaceAll(root, '<root>') : null;
      if (shown !== row[2]) return false;
    } else if (kind === 'git') {
      const cwd = resolve(root, name);
      if (replayGit(row[2], cwd, context) !== row[3]) return false;
    } else if (kind === 'tree') {
      if (treeValue(name, repository, context.memo.trees) !== row[2]) return false;
    } else if (kind === 'all-dist') {
      if (allDistValue(context) !== row[2]) return false;
    } else if (kind === 'dist') {
      if (distValue(name, context) !== row[2]) return false;
    } else if (kind === 'file' || kind === 'dir' || kind === 'exists') {
      const read = kind === 'dir' ? 'd' : kind === 'exists' ? 'e' : 'r';
      if (hasher.value(read, resolve(root, name)) !== row[2]) return false;
    }
  }
  return true;
}

function lockHolds(text, repository) {
  const space = text.indexOf(' '),
    head = text.slice(0, space),
    integrity = text.slice(space + 1),
    at = head.lastIndexOf('@'),
    key = head.slice(0, at),
    entry = repository.lock[key];
  return Boolean(entry) && (entry.version ?? '') === head.slice(at + 1) && (entry.integrity ?? '') === integrity;
}

/**
 * The on-disk store. Writes go through a temp name and a hard link, so a concurrent reader never sees half an entry. A
 * key names exact inputs, so two runs writing one key hold the same answer: the first stays. Replacing it instead fails
 * on Windows (EPERM) while another run touches the file, and ended verify when two ran at once.
 */
// Lanes share one store and each `put` prunes its step, so a file listed a moment ago may be gone: that is a pass that
// is no longer stored, the same as one never stored. Anything but a missing file still throws.
/** When a stored entry was written, or undefined once another run has pruned it. */
const modified = (file) => statSync(file, { throwIfNoEntry: false })?.mtimeMs;
/**
 * Deletes a stored file. While Windows deletes a file, opening that name fails with EPERM, which a reader cannot tell from
 * a real refusal. So the file leaves its name first, in one step, and only a name no reader lists is deleted. Windows can
 * refuse the move (EPERM, EBUSY) while another lane moves the same file, and that lane may have won (ENOENT). A refused
 * file is only over the limit, not wrong: it stays until the next prune.
 * @returns False when the file stayed. Anything else still throws.
 */
function retire(file) {
  try {
    const gone = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    renameSync(file, gone);
    rmSync(gone, { force: true });
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    if (error.code === 'EPERM' || error.code === 'EBUSY') return false;
    throw error;
  }
}
/** A stored entry, or undefined once another run has pruned it. */
function readEntry(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export class ResultStore {
  constructor(dir = defaultStoreDir(), { capBytes = CAP_BYTES } = {}) {
    this.dir = dir;
    this.capBytes = capBytes;
    for (const part of ['steps', 'poison', 'dist']) mkdirSync(join(dir, part), { recursive: true });
  }
  #stepDir(step) {
    return join(this.dir, 'steps', sha256(step).slice(0, 32));
  }
  #atomicWrite(file, bytes) {
    const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(temporary, bytes);
    try {
      linkSync(temporary, file);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const now = new Date();
      utimesSync(file, now, now);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  /** A stored pass for this exact key, or undefined. A poisoned key is never returned. */
  get(step, key) {
    if (this.isPoisoned(key)) return undefined;
    return readEntry(join(this.#stepDir(step), `${key}.json`));
  }
  /** Stored passes of a step, newest first, without poisoned keys. */
  candidates(step) {
    const folder = this.#stepDir(step);
    if (!existsSync(folder)) return [];
    return readdirSync(folder)
      .filter((name) => name.endsWith('.json'))
      .map((name) => ({ name, at: modified(join(folder, name)) }))
      .filter(({ at }) => at !== undefined)
      .sort((a, b) => b.at - a.at)
      .slice(0, CANDIDATES_PER_STEP)
      .filter(({ name }) => !this.isPoisoned(name.slice(0, -5)))
      .map(({ name }) => readEntry(join(folder, name)))
      .filter((entry) => entry !== undefined);
  }
  /** Stores a pass. Refuses anything else: a failure, or a key already poisoned, is never stored. */
  put(entry) {
    if (entry.passed !== true)
      throw margoError(
        'RESULT_CACHE_FAILURE_STORED',
        `${entry.step}: only a first-try pass may be stored; do not store a failure`,
      );
    if (this.isPoisoned(entry.key)) return false;
    const folder = this.#stepDir(entry.step);
    mkdirSync(folder, { recursive: true });
    this.#atomicWrite(join(folder, `${entry.key}.json`), JSON.stringify(entry));
    this.#pruneStep(folder);
    return true;
  }
  #pruneStep(folder) {
    const names = readdirSync(folder).filter((name) => name.endsWith('.json'));
    if (names.length <= CANDIDATES_PER_STEP) return;
    names
      .map((name) => ({ name, at: modified(join(folder, name)) ?? 0 }))
      .sort((a, b) => b.at - a.at)
      .slice(CANDIDATES_PER_STEP)
      .forEach(({ name }) => retire(join(folder, name)));
  }
  /** Marks a key as never to be served again. */
  poison(key, why) {
    writeFileSync(join(this.dir, 'poison', key), `${why}\n`);
  }
  isPoisoned(key) {
    return existsSync(join(this.dir, 'poison', key));
  }
  /** Packs a folder into one gzip file under the key. Later phases restore it instead of building. */
  storeOutput(key, folder) {
    const file = join(this.dir, 'dist', `${key}.gz`);
    if (existsSync(file)) {
      const now = new Date();
      utimesSync(file, now, now);
      return file;
    }
    const files = listFiles(folder),
      header = Buffer.from(JSON.stringify(files.map(({ name, size }) => [name, size]))),
      length = Buffer.alloc(4);
    length.writeUInt32LE(header.length);
    const packed = gzipSync(Buffer.concat([length, header, ...files.map(({ path }) => readFileSync(path))]), {
      level: 1,
    });
    this.#atomicWrite(file, packed);
    this.evict();
    return file;
  }
  /** Clears `folder` and writes the stored output back. Returns false when the key holds none. */
  restoreOutput(key, folder) {
    const file = join(this.dir, 'dist', `${key}.gz`);
    if (this.isPoisoned(key)) return false;
    const packed = readStored(file);
    if (!packed) return false;
    const bytes = gunzipSync(packed),
      length = bytes.readUInt32LE(0),
      header = JSON.parse(bytes.subarray(4, 4 + length).toString());
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    let at = 4 + length;
    for (const [name, size] of header) {
      const target = join(folder, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes.subarray(at, at + size));
      at += size;
    }
    return true;
  }
  /** Removes the oldest stored outputs until the store is under its cap. */
  evict() {
    const folder = join(this.dir, 'dist'),
      files = readdirSync(folder)
        .filter((name) => name.endsWith('.gz'))
        // Worktrees share the store, so another run may have removed a file since the listing: it is no longer stored.
        .flatMap((name) => {
          const path = join(folder, name),
            stat = statSync(path, { throwIfNoEntry: false });
          return stat ? [{ path, ...pick(stat) }] : [];
        })
        .sort((a, b) => a.at - b.at);
    let total = files.reduce((sum, { size }) => sum + size, 0);
    for (const { path, size } of files) {
      if (total <= this.capBytes) break;
      if (retire(path)) total -= size;
    }
    return total;
  }
}

const pick = (stat) => ({ at: stat.mtimeMs, size: stat.size });
/** A stored output's bytes, or undefined once another run has evicted it. */
function readStored(file) {
  try {
    return readFileSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function listFiles(folder, prefix = '') {
  const out = [];
  for (const name of readdirSync(join(folder, prefix)).sort()) {
    const inner = prefix ? `${prefix}/${name}` : name,
      path = join(folder, inner),
      stat = lstatSync(path);
    if (stat.isDirectory()) out.push(...listFiles(folder, inner));
    else out.push({ name: inner, path, size: stat.size });
  }
  return out;
}

/** The SHA-256 of every file in a folder, by name: what "build twice, same bytes" compares. */
export function hashFolder(folder) {
  const hash = createHash('sha256');
  for (const { name, path } of listFiles(folder)) hash.update(`${name}\0`).update(readFileSync(path)).update('\0');
  return hash.digest('hex');
}

/**
 * One verify run in shadow mode. `stepEnv` gives a step its recording folder; `finish` collects what it read, records
 * the result and answers whether the store would have served it. Nothing here can skip a step.
 */
export class ShadowRun {
  constructor({
    root,
    store = new ResultStore(),
    repository = readRepository(root),
    facts = machineFacts(),
    runId,
    commit,
    env = process.env,
  }) {
    this.root = resolve(root);
    this.store = store;
    this.facts = facts;
    this.env = env;
    this.runId = runId ?? `${Date.now()}-${process.pid}`;
    this.commit = commit ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
    this.work = join(root, 'test-results', 'cache', 'runs', this.runId);
    this.hasher = new Hasher();
    this.context = { repository, hasher: this.hasher, outputs: new Set(), memo: { trees: new Map() } };
    this.rows = [];
    this.disagreements = [];
    this.count = 0;
  }

  /** The environment for one recorded step. `perTest` gives each test file its own scope. */
  stepEnv(perTest = false) {
    const dir = join(this.work, String(++this.count)),
      self = `--import=${new URL('./record-reads.mjs', import.meta.url).href}`;
    const { MARGO_RECORD_SCOPE, MARGO_RECORD_PER_TEST, ...outer } = this.env;
    return {
      dir,
      env: {
        ...outer,
        MARGO_RECORD_DIR: dir,
        NODE_OPTIONS: this.env.NODE_OPTIONS ? `${this.env.NODE_OPTIONS} ${self}` : self,
        ...(perTest ? { MARGO_RECORD_PER_TEST: '1' } : {}),
      },
    };
  }

  /**
   * Records a finished step. `kind` is 'step' (one key), 'tests' (one key per test file) or 'builds' (one key per
   * package, the process shared by the jobs named with recordScope).
   */
  finish(step, dir, { kind = 'step', code, seconds = 0 }) {
    const { scopes, order } = collectLogs(dir);
    const unfinished = (record) => (record.incomplete ? ['a recorded process did not finish'] : []);
    // Everything this step wrote can be read by a later one; a read by an earlier one is not its output.
    const addFolder = (folder) => {
      if (!existsSync(folder)) return;
      for (const { path } of listFiles(folder)) {
        this.context.outputs.add(posix(relative(this.root, path)));
        this.hasher.forget(path);
      }
    };
    const addOutputs = (record) => {
      for (const path of record.writes.keys()) {
        const inside = relative(this.root, path);
        if (!inside.startsWith('..')) this.context.outputs.add(posix(inside));
        this.hasher.forget(path);
      }
    };
    const rows = [];
    if (kind === 'step') {
      const whole = mergeScopes([...scopes.values()]);
      const incomplete = [...scopes.values()].flatMap(unfinished);
      rows.push(this.#record(step, whole, { passed: code === 0, seconds, incomplete }));
      addOutputs(whole);
      // A sandbox's bundler writes natively, so its dist is listed here for the sandbox's tests.
      const sandbox = /^npm run build --workspace (examples\/[\w-]+)$/.exec(step)?.[1];
      if (sandbox) addFolder(join(this.root, sandbox, 'dist'));
    } else if (kind === 'tests') {
      for (const [name, record] of scopes) {
        if (!name) continue;
        const file = posix(relative(this.root, name.slice('test:'.length)));
        const known = record.exitCode !== undefined;
        rows.push(
          this.#record(`test:${file}`, record, {
            passed: record.exitCode === 0,
            seconds: record.seconds,
            incomplete: known ? unfinished(record) : ['the test process did not finish'],
            extraRefusal: WALL_CLOCK_TESTS.has(file.split('/').at(-1)) ? `times real work: ${file}` : undefined,
          }),
        );
        addOutputs(record);
      }
    } else {
      const base = scopes.get('');
      const named = order.filter(Boolean);
      const dependencies = packageDependencies(readManifests(this.root));
      for (const [index, name] of named.entries()) {
        const record = scopes.get(name);
        // A build stops at its first failure, which is the last job it started; the ones before it finished.
        const passed = code === 0 || index < named.length - 1;
        const packageName = name.startsWith('package:') ? name.slice('package:'.length) : undefined;
        // The bundler reads sources and writes dist natively, so a package build declares both. It also reads the dist
        // of what the package depends on: a subpath outside the external list is inlined, and a worker bundle takes in
        // everything it imports, while tsc sees only the .d.ts beside that code. So the key names the dist of every
        // package the build order puts first. A build whose bytes differ on equal keys is a disagreement.
        if (packageName) {
          const dist = join(this.root, 'packages', packageName, 'dist');
          record.covers.add(dist);
          addFolder(dist);
        }
        rows.push(
          this.#record(`build:${name}`, record, {
            passed,
            seconds: record.seconds,
            incomplete: [...unfinished(record), ...(base ? unfinished(base) : [])],
            base,
            declared: packageName ? [`^packages/${packageName}/(?!tests?/|.*\\.md$)`, '^packages/shared/'] : undefined,
            builtOn: packageName ? packageClosure(packageName, dependencies).sort() : undefined,
            output: name.startsWith('package:')
              ? join(this.root, 'packages', name.slice('package:'.length), 'dist')
              : undefined,
          }),
        );
        addOutputs(record);
      }
      if (base) addOutputs(base);
    }
    rmSync(dir, { recursive: true, force: true });
    this.rows.push(...rows);
    return rows;
  }

  #record(step, record, { passed, seconds, incomplete, base, output, extraRefusal, declared, builtOn }) {
    const context = { ...this.context, base, declared, builtOn };
    context.git = this.context.git ??= new Map();
    const { inputs, refused } = buildManifest(record, context);
    refused.push(...incomplete);
    if (extraRefusal) refused.push(extraRefusal);
    const key = refused.length ? null : computeKey(step, inputs, this.facts);
    const liveEnv = new Map([...(base?.env ?? []), ...record.env]);
    const would = this.store
      .candidates(step)
      .find((entry) => sameFacts(entry.facts, this.facts) && manifestHolds(entry, context, liveEnv));
    const row = {
      step,
      key,
      passed,
      seconds: Math.round(seconds * 10) / 10,
      cache: {
        key: would?.key ?? key,
        hit: false,
        wouldHit: Boolean(would),
        from: would ? { run: would.run, commit: would.commit, date: would.date } : null,
      },
      refused,
    };
    if (would && !passed) this.#disagree('failed-on-stored-pass', step, would, key, 'poisoned');
    else if (key && !passed && this.store.get(step, key))
      this.#disagree('failed-on-stored-pass', step, this.store.get(step, key), key, 'poisoned');
    if (passed && would && key && key !== would.key)
      this.#disagree(
        'inputs-moved',
        step,
        would,
        key,
        'the tree matches a stored pass yet this run read something else: a hidden input',
        inputDifference(would.inputs, inputs),
      );
    const outputHash = output && passed && existsSync(output) ? hashFolder(output) : undefined;
    if (outputHash && would?.outputHash && would.outputHash !== outputHash)
      this.#disagree('output-differs', step, would, key, 'same inputs built different bytes');
    if (passed && key && !this.store.isPoisoned(key)) {
      this.store.put({
        step,
        key,
        passed: true,
        run: this.runId,
        commit: this.commit,
        date: new Date().toISOString(),
        seconds: row.seconds,
        facts: this.facts,
        inputs,
        outputHash,
      });
      if (output && existsSync(output)) this.store.storeOutput(key, output);
    }
    return row;
  }

  #disagree(kind, step, stored, key, what, difference) {
    const row = {
      kind,
      step,
      what,
      ...(difference ? { difference } : {}),
      key,
      storedKey: stored.key,
      stored: { run: stored.run, commit: stored.commit, date: stored.date },
      run: this.runId,
      commit: this.commit,
      date: new Date().toISOString(),
    };
    this.disagreements.push(row);
    this.store.poison(stored.key, `${kind} in run ${this.runId} at ${this.commit}`);
    if (key && key !== stored.key) this.store.poison(key, `${kind} in run ${this.runId} at ${this.commit}`);
    const ledger = join(this.root, 'test-results', 'cache', 'disagreements.json');
    mkdirSync(dirname(ledger), { recursive: true });
    const earlier = existsSync(ledger) ? JSON.parse(readFileSync(ledger, 'utf8')) : [];
    writeFileSync(ledger, `${JSON.stringify([...earlier, row], null, 2)}\n`);
  }

  /** The totals and the report file: test-results/cache/shadow-report.json. */
  report() {
    const rows = this.rows,
      wouldHit = rows.filter((row) => row.cache.wouldHit),
      refused = rows.filter((row) => row.refused.length),
      summary = {
        run: this.runId,
        commit: this.commit,
        mode: 'shadow',
        servingRequested: servingRequested(this.env),
        steps: rows.length,
        wouldHit: wouldHit.length,
        wouldSaveSeconds: Math.round(wouldHit.reduce((sum, row) => sum + row.seconds, 0)),
        uncacheable: refused.length,
        disagreements: this.disagreements.length,
      };
    const file = join(this.root, 'test-results', 'cache', 'shadow-report.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ ...summary, rows, disagreementRows: this.disagreements }, null, 2)}\n`);
    rmSync(this.work, { recursive: true, force: true });
    return summary;
  }
}

/** What separates two manifests, for the ledger: enough rows to name the hidden input. */
function inputDifference(stored, current) {
  const text = (rows) => new Set(rows.map((row) => JSON.stringify(row))),
    before = text(stored),
    after = text(current);
  return {
    gone: [...before].filter((row) => !after.has(row)).slice(0, 20),
    added: [...after].filter((row) => !before.has(row)).slice(0, 20),
  };
}

const sameFacts = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

function mergeScopes(records) {
  const out = {
    reads: new Map(),
    writes: new Map(),
    covers: new Set(),
    env: new Map(),
    git: new Map(),
    opaque: new Set(),
    net: new Set(),
    clocks: new Map(),
  };
  for (const record of records) {
    for (const [path, entry] of record.reads) {
      const had = out.reads.get(path);
      if (!had) out.reads.set(path, [...entry]);
      else mergeRead(had, entry[0], entry[1]);
    }
    for (const [path, at] of record.writes) out.writes.set(path, Math.min(at, out.writes.get(path) ?? at));
    for (const path of record.covers) out.covers.add(path);
    for (const [key, value] of record.env) out.env.set(key, value);
    for (const [key, value] of record.git) out.git.set(key, value);
    for (const program of record.opaque) out.opaque.add(program);
    for (const host of record.net) out.net.add(host);
    for (const [file, what] of record.clocks) out.clocks.set(file, what);
  }
  return out;
}
