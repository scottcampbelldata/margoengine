// A Node preload (NODE_OPTIONS=--import) that records what a process really reads while a check runs: files and
// existence checks, folder listings, modules it loads, environment variables with their values, git commands, native
// commands it starts, network hosts, and calls to Date.now and Math.random with the file that made them. Writes are
// recorded too, so a read of a step's own output is not counted as an input. The log goes to one file per process in
// MARGO_RECORD_DIR at exit; scripts/support/result-cache.mjs turns the logs into content keys. Nothing happens without
// MARGO_RECORD_DIR. Children inherit the recorder: spawn calls add it to an explicit `env` as well.
//
// Known limits, all caught by the uncached nightly (a key it fails is a disagreement): `new Date()` is not seen, and a
// native program started from inside an npm script is not seen, because npm's own process is not recorded.
import { AsyncLocalStorage } from 'node:async_hooks';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { threadId } from 'node:worker_threads';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

/** Environment names the recorder itself sets or that only carry it. */
export const RECORDER_ENV = new Set([
  'MARGO_RECORD_DIR',
  'MARGO_RECORD_SCOPE',
  'MARGO_RECORD_PER_TEST',
  'NODE_OPTIONS',
  'NODE_TEST_CONTEXT',
]);

/**
 * Files allowed to call Date.now or Math.random without marking a step nondeterministic: they time or name things for
 * the checks, and the value never decides an outcome. These are path endings without the top folder on purpose: the
 * affected-file map follows any repo path named in a string, and naming these whole would pull them into verify's files.
 */
export const CLOCK_INFRASTRUCTURE = [
  '/browser.js',
  '/gpu-lock.mjs',
  '/lib/browser.mjs',
  '/support/run-limited.mjs',
  '/support/record-reads.mjs',
];

/** How much of a file a read depends on: existence, then its listing, then its bytes, then its bytes as a module. */
export const READ_RANK = { e: 0, d: 1, r: 2, m: 3 };

/** Calls walked per process before the recorder gives up attributing them and marks the process. */
const CLOCK_BUDGET = 20000;

/** True when a clock call from this file cannot change a result: third-party code or the listed infrastructure. */
export function isClockInfrastructure(file) {
  const path = file.replaceAll('\\', '/');
  return path.includes('/node_modules/') || CLOCK_INFRASTRUCTURE.some((end) => path.endsWith(end));
}

/** What a native command is to the recorder: `node` (recorded through inheritance), `git`, or an opaque program. */
export function classifyCommand(command, isFile = false) {
  // A file path may hold spaces (C:\Program Files\nodejs\node.exe); only a shell string splits into words.
  const words = isFile ? [String(command)] : (String(command).match(/"[^"]*"|\S+/g) ?? []);
  let index = 0;
  const name = (word) =>
    basename(String(word).replaceAll('"', '').replaceAll('\\', '/'))
      .toLowerCase()
      .replace(/\.(exe|cmd|bat)$/, '');
  while (name(words[index] ?? '') === 'cmd' || /^\/[a-z]$/i.test(words[index] ?? '')) index++;
  const program = name(words[index] ?? '');
  // tsc and vite are Node programs behind a shim: they inherit the recorder.
  if (['node', 'npm', 'npx', 'tsc', 'vite'].includes(program)) return { kind: 'node', program };
  if (program === 'git')
    return { kind: 'git', program, args: words.slice(index + 1).map((w) => w.replaceAll('"', '')) };
  return { kind: 'opaque', program };
}

function pathOf(value) {
  if (typeof value === 'string') return resolve(value);
  if (value instanceof URL) return value.protocol === 'file:' ? resolve(fileURLToPath(value)) : undefined;
  if (Buffer.isBuffer(value)) return resolve(value.toString());
  return undefined;
}

const isWriteFlag = (flags) =>
  typeof flags === 'number' ? (flags & 3) !== 0 || (flags & fs.constants.O_CREAT) !== 0 : /[wa+]/.test(flags ?? 'r');

function install(dir) {
  const original = {
    writeFileSync: fs.writeFileSync,
    mkdirSync: fs.mkdirSync,
    appendFileSync: fs.appendFileSync,
    now: Date.now,
    random: Math.random,
  };
  const rawEnv = process.env,
    temp = resolve(tmpdir()) + sep,
    perTest = rawEnv.MARGO_RECORD_PER_TEST === '1' && !rawEnv.MARGO_RECORD_SCOPE && rawEnv.NODE_TEST_CONTEXT;
  const lead = Boolean(perTest && process.argv[1]);
  if (lead) rawEnv.MARGO_RECORD_SCOPE = `test:${resolve(process.argv[1])}`;
  const startedAt = original.now();
  const newSegment = (scope) => ({
    scope,
    started: performance.now(),
    reads: new Map(),
    writes: new Map(),
    covers: new Set(),
    env: new Map(),
    git: new Map(),
    opaque: new Set(),
    net: new Set(),
    clocks: new Map(),
  });
  const segments = [newSegment(rawEnv.MARGO_RECORD_SCOPE ?? '')];
  let segment = segments[0];
  // A job run side by side with others (recordJob) keeps its own segment through its async work.
  const jobs = new AsyncLocalStorage();
  const active = () => jobs.getStore() ?? segment;
  const writtenEnv = new Set();
  // Windows reuses process ids within one long step, so the id alone would let a later process overwrite a log.
  const logName = `${process.pid}-${threadId}-${startedAt}-${original.random().toString(36).slice(2, 10)}`;

  original.mkdirSync(dir, { recursive: true });
  original.appendFileSync(join(dir, 'starts.log'), `${logName}\t${rawEnv.MARGO_RECORD_SCOPE ?? ''}\n`);

  const stamp = () => performance.timeOrigin + performance.now();
  const noteRead = (path, kind) => {
    if (path === undefined) return;
    const entry = active().reads.get(path);
    if (entry === undefined) active().reads.set(path, [kind, stamp()]);
    else if (READ_RANK[kind] > READ_RANK[entry[0]]) {
      // The time kept is of the strongest read: an existence check before a tool writes a file is not reading it.
      entry[0] = kind;
      entry[1] = stamp();
    }
  };
  const noteWrite = (path) => {
    if (path === undefined) return;
    if (!active().writes.has(path)) active().writes.set(path, stamp());
  };
  const noteCover = (path) => {
    if (path === undefined) return;
    active().covers.add(path);
    noteWrite(path);
  };

  // --- files ---
  const wrap = (holder, name, before, after) => {
    const inner = holder[name];
    if (typeof inner !== 'function') return;
    const wrapped = function (...args) {
      before(args);
      const result = Reflect.apply(inner, this, args);
      return after ? after(result, args) : result;
    };
    Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(inner));
    holder[name] = wrapped;
  };
  const read = (args) => noteRead(pathOf(args[0]), 'r');
  const listed = (args) => noteRead(pathOf(args[0]), 'd');
  const exists = (args) => noteRead(pathOf(args[0]), 'e');
  const written = (args) => noteWrite(pathOf(args[0]));
  const made = (args) => {
    const path = pathOf(args[0]);
    if (path?.startsWith(temp)) noteCover(path);
  };
  const copied = (args) => {
    noteRead(pathOf(args[0]), 'r');
    noteWrite(pathOf(args[1]));
  };
  const coveredCopy = (args) => {
    noteRead(pathOf(args[0]), 'r');
    noteCover(pathOf(args[1]));
  };
  const opened = (args) => {
    if (isWriteFlag(args[1])) noteWrite(pathOf(args[0]));
    else noteRead(pathOf(args[0]), 'r');
  };
  const tempMade = (result) => {
    if (typeof result === 'string') noteCover(resolve(result));
    else if (typeof result?.then === 'function')
      return result.then((path) => {
        noteCover(resolve(String(path?.path ?? path)));
        return path;
      });
    else if (result?.path) noteCover(resolve(result.path));
    return result;
  };
  const tempMadeCallback = (args) => {
    const last = args.length - 1,
      callback = args[last];
    if (typeof callback === 'function')
      args[last] = (error, path) => {
        if (!error) noteCover(resolve(path));
        callback(error, path);
      };
  };
  const callbackAndSync = (name, handler) => {
    wrap(fs, name, handler);
    wrap(fs, `${name}Sync`, handler);
    wrap(fs.promises, name, handler);
  };
  for (const name of ['readFile']) callbackAndSync(name, read);
  for (const name of ['opendir']) callbackAndSync(name, listed);
  callbackAndSync('readdir', listed);
  for (const name of ['stat', 'lstat', 'access', 'realpath']) callbackAndSync(name, exists);
  wrap(fs.realpath, 'native', exists);
  wrap(fs.realpathSync, 'native', exists);
  wrap(fs, 'exists', exists);
  wrap(fs, 'existsSync', exists);
  wrap(fs, 'createReadStream', read);
  wrap(fs, 'createWriteStream', written);
  for (const name of ['writeFile', 'appendFile', 'rm', 'rmdir', 'unlink', 'truncate']) callbackAndSync(name, written);
  callbackAndSync('mkdir', made);
  callbackAndSync('copyFile', copied);
  callbackAndSync('cp', coveredCopy);
  callbackAndSync('rename', coveredCopy);
  callbackAndSync('open', opened);
  wrap(fs, 'mkdtempSync', () => {}, tempMade);
  wrap(fs.promises, 'mkdtemp', () => {}, tempMade);
  wrap(fs, 'mkdtemp', tempMadeCallback);

  // Module loads go through Node's internal reader, so a hook sees them. The kind 'm' also pulls in the nearest
  // package.json at key time, since `exports` and `type` change what a load means.
  // A resolve hook, because a load hook makes Node fetch every source in JavaScript, which costs seconds on tsc.
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (result.url.startsWith('file:')) noteRead(resolve(fileURLToPath(result.url)), 'm');
      return result;
    },
  });

  // --- environment ---
  // `{ ...process.env }` and Object.keys touch every key without any code using the values; the child's own reads are
  // what count. A get right after the descriptor call of an enumeration is that copy, not a read.
  let enumeration, pending;
  process.env = new Proxy(rawEnv, {
    get(target, key) {
      if (typeof key === 'string') {
        if (pending === key) pending = undefined;
        else if (!RECORDER_ENV.has(key) && !writtenEnv.has(key) && !active().env.has(key))
          active().env.set(key, target[key] ?? null);
      }
      return target[key];
    },
    has(target, key) {
      if (typeof key === 'string' && !RECORDER_ENV.has(key) && !writtenEnv.has(key) && !active().env.has(key))
        active().env.set(key, target[key] ?? null);
      return key in target;
    },
    set(target, key, value) {
      if (typeof key === 'string') writtenEnv.add(key);
      target[key] = value;
      return true;
    },
    deleteProperty(target, key) {
      if (typeof key === 'string') writtenEnv.add(key);
      delete target[key];
      return true;
    },
    ownKeys(target) {
      enumeration = Reflect.ownKeys(target);
      return enumeration;
    },
    getOwnPropertyDescriptor(target, key) {
      if (enumeration?.includes(key)) pending = key;
      else if (typeof key === 'string' && !RECORDER_ENV.has(key) && !writtenEnv.has(key) && !active().env.has(key))
        active().env.set(key, target[key] ?? null);
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });

  // --- child processes ---
  const self = `--import=${import.meta.url}`;
  const childEnv = (env) => {
    const out = env ? { ...env } : { ...rawEnv };
    // A child given its own recording folder is its own recording; every other child belongs to this scope.
    if (env?.MARGO_RECORD_DIR === undefined || env.MARGO_RECORD_DIR === rawEnv.MARGO_RECORD_DIR) {
      out.MARGO_RECORD_DIR = rawEnv.MARGO_RECORD_DIR;
      const scope = jobs.getStore()?.scope ?? rawEnv.MARGO_RECORD_SCOPE;
      if (scope !== undefined) out.MARGO_RECORD_SCOPE = scope;
    }
    if (!String(out.NODE_OPTIONS ?? '').includes(self))
      out.NODE_OPTIONS = out.NODE_OPTIONS ? `${out.NODE_OPTIONS} ${self}` : self;
    return out;
  };
  const noteCommand = (text, explicitArgs, options, isFile) => {
    const found = classifyCommand(text, isFile);
    if (found.kind === 'opaque') active().opaque.add(found.program);
    if (found.kind === 'git') {
      const args = [...found.args, ...(explicitArgs ?? [])].map(String);
      const cwd = resolve(options?.cwd instanceof URL ? fileURLToPath(options.cwd) : (options?.cwd ?? process.cwd()));
      active().git.set(JSON.stringify([args, cwd]), [args, cwd]);
    }
  };
  // Where the options object sits: after the args array, or after an explicit undefined in its place.
  const optionsAt = (args) => (Array.isArray(args[1]) || (args[1] === undefined && args.length > 2) ? 2 : 1);
  const withEnv = (args, at) => {
    const given = typeof args[at] === 'object' && args[at] !== null,
      options = given ? args[at] : {},
      next = { ...options, env: childEnv(options.env) };
    if (given) args[at] = next;
    else args.splice(at, 0, next);
    return args;
  };
  const fileAndArgs = (args) => {
    const file = args[0],
      list = Array.isArray(args[1]) ? args[1] : undefined,
      at = optionsAt(args);
    const shell = typeof args[at] === 'object' && args[at]?.shell;
    if (shell) noteCommand(list ? `${file} ${list.join(' ')}` : file, undefined, args[at]);
    else noteCommand(file, list, args[at], true);
    // An allocation probe measures its own heap, and any --import preload, even an empty one, moves its first window by
    // about 200 B per call. So it runs unrecorded, and the mark keeps this scope out of the store.
    if (list?.includes('--expose-gc')) {
      active().clocks.set('--expose-gc process', 'allocation probes');
      const options = typeof args[at] === 'object' && args[at] !== null ? args[at] : {},
        env = { ...(options.env ?? rawEnv) };
      env.NODE_OPTIONS = String(env.NODE_OPTIONS ?? '')
        .replace(self, '')
        .trim();
      if (!env.NODE_OPTIONS) delete env.NODE_OPTIONS;
      delete env.MARGO_RECORD_DIR;
      if (options === args[at]) args[at] = { ...options, env };
      else args.splice(at, 0, { env });
      return args;
    }
    return withEnv(args, at);
  };
  const stringCommand = (args) => {
    noteCommand(args[0], undefined, typeof args[1] === 'object' ? args[1] : undefined);
    return withEnv(args, 1);
  };
  const wrapChild = (name, rewrite) => {
    const inner = childProcess[name],
      wrapped = function (...args) {
        return Reflect.apply(inner, this, rewrite(args));
      };
    Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(inner));
    childProcess[name] = wrapped;
  };
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) wrapChild(name, fileAndArgs);
  wrapChild('exec', stringCommand);
  wrapChild('execSync', stringCommand);
  wrapChild('fork', (args) => withEnv(args, optionsAt(args)));

  // --- network ---
  const isLocal = (host) =>
    host === undefined ||
    host === null ||
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host === '0.0.0.0';
  const noteHost = (host) => {
    if (!isLocal(host)) active().net.add(String(host));
  };
  const socketHost = (args) => {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (typeof first === 'object' && first !== null) {
      if (first.path === undefined) noteHost(first.host ?? first.hostname);
    } else if (typeof args[1] === 'string') noteHost(args[1]);
  };
  wrap(net, 'connect', socketHost);
  wrap(net, 'createConnection', socketHost);
  wrap(tls, 'connect', socketHost);
  if (typeof globalThis.fetch === 'function') {
    const innerFetch = globalThis.fetch;
    globalThis.fetch = function fetch(input, init) {
      const url = typeof input === 'string' ? input : (input?.url ?? input?.href ?? '');
      if (URL.canParse(url)) noteHost(new URL(url).hostname);
      return Reflect.apply(innerFetch, this, [input, init]);
    };
  }

  // --- clocks and randomness ---
  // A stack per call would be slow in a hot loop, so the first call that marks the process restores the real function,
  // and a process whose calls stay in infrastructure past the budget is marked as unattributed.
  let clockCalls = 0;
  const restoreClocks = () => {
    Date.now = original.now;
    Math.random = original.random;
  };
  const noteClock = (what) => {
    if (++clockCalls > CLOCK_BUDGET) {
      active().clocks.set(`unattributed ${what}`, what);
      restoreClocks();
      return;
    }
    const holder = {},
      limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 4;
    Error.captureStackTrace(holder, noteClock);
    Error.stackTraceLimit = limit;
    const frame = holder.stack?.split('\n')[2] ?? '',
      at = /(?:\(|at )((?:file:\/\/\/|[A-Za-z]:|\/)[^()]*?):\d+:\d+\)?$/.exec(frame);
    if (!at) return;
    const file = at[1].startsWith('file:') ? fileURLToPath(at[1]) : at[1];
    if (isClockInfrastructure(file)) return;
    active().clocks.set(file, what);
    restoreClocks();
  };
  Date.now = function now() {
    noteClock('Date.now');
    return original.now();
  };
  Math.random = function random() {
    noteClock('Math.random');
    return original.random();
  };

  syncBuiltinESMExports();

  // --- the log ---
  process.on('exit', (exitCode) => {
    const finished = performance.now();
    const log = {
      pid: process.pid,
      thread: threadId,
      main: process.argv[1] ?? null,
      lead,
      exitCode,
      startedAt,
      segments: segments.map((part, index) => ({
        scope: part.scope,
        seconds: ((part.ended ?? segments[index + 1]?.started ?? finished) - part.started) / 1000,
        reads: [...part.reads],
        writes: [...part.writes],
        covers: [...part.covers],
        env: [...part.env],
        git: [...part.git.values()],
        opaque: [...part.opaque],
        net: [...part.net],
        clocks: [...part.clocks],
      })),
    };
    original.mkdirSync(dir, { recursive: true });
    original.writeFileSync(join(dir, `${logName}.json`), JSON.stringify(log));
  });

  // A process that does many jobs in turn (build-modern.js, one per package) names each one. Children started after
  // this call inherit the name.
  globalThis[Symbol.for('margoengine.recordReads')] = {
    scope(name) {
      // A build run inside a test (the determinism test) stays part of that test's key.
      if (rawEnv.MARGO_RECORD_SCOPE?.startsWith('test:')) return;
      rawEnv.MARGO_RECORD_SCOPE = name;
      segment = newSegment(name);
      segments.push(segment);
    },
    job(name, work) {
      if (rawEnv.MARGO_RECORD_SCOPE?.startsWith('test:')) return work();
      const part = newSegment(name);
      segments.push(part);
      return jobs.run(part, async () => {
        try {
          return await work();
        } finally {
          part.ended = performance.now();
        }
      });
    },
  };
}

/** Starts a named job in the current recording; does nothing when the process is not being recorded. */
export function recordScope(name) {
  globalThis[Symbol.for('margoengine.recordReads')]?.scope(name);
}

/**
 * Runs `work` as a named job that may overlap other jobs: its reads, writes and children stay under its name.
 * Without a recording it only runs `work`.
 */
export function recordJob(name, work) {
  const recording = globalThis[Symbol.for('margoengine.recordReads')];
  return recording ? recording.job(name, work) : work();
}

const recordDir = process.env.MARGO_RECORD_DIR,
  isNpmCli = /[\\/]node_modules[\\/]npm[\\/]/.test(process.argv[1] ?? '');
if (recordDir && !isNpmCli && !globalThis[Symbol.for('margoengine.recordReads')]) install(resolve(recordDir));
