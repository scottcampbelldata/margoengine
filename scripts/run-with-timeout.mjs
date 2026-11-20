// Runs a command with a hard timeout. GPU work runs directly with a hard timeout; no GPU lock is used, ever (Scott,
// 2026-11-16). Past `--max` minutes (default 10) the command's whole process tree is ended and this exits 124 with
// "TIMEOUT after N min: <command>"; otherwise it exits with the command's own code.
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { showHelp } from './support/help.mjs';

/** The hard timeout of a command, in minutes, when none is given. */
export const DEFAULT_MINUTES = 10;

/**
 * Ends a process and everything it started. On Windows `taskkill /T /F` (a plain kill stops only the shell or launcher
 * and leaves browsers, servers and kernels running); elsewhere the process group, which {@link runWithTimeout} makes.
 */
export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 10_000, windowsHide: true });
  else
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
}

/**
 * `arg` quoted for a cmd.exe command line read back by the C runtime's argument parser: plain words stay as they are,
 * anything else is wrapped in double quotes with embedded quotes (and the backslashes before them) escaped.
 */
export function quoteWindows(arg) {
  if (/^[\w@+=:,./\\-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * A command line for cmd.exe (`shell: true` on Windows) that hands the program `args` exactly: each quoted for the
 * program ({@link quoteWindows}), then made literal to cmd. cmd reads the line first and toggles its own quoting at
 * every ", the escaped \" included, so a | & < > ( ) ^ after an escaped quote stood outside cmd's quotes and ran as its
 * operator ('a"|b' piped into a command named b). A caret before each such character, with cmd's quote state followed
 * across the whole line, makes it literal; cmd removes the caret again.
 */
export function windowsCommandLine(args) {
  let out = '',
    open = false;
  for (const char of args.map(quoteWindows).join(' ')) {
    if (char === '"') open = !open;
    else if (!open && '()^<>&|'.includes(char)) out += '^';
    out += char;
  }
  return out;
}

/**
 * Starts `command` (a shell string, or [program, ...args]) with output passed through and ends its whole process tree
 * past `timeoutMs`. Resolves to {code, timedOut} (code 124 on a timeout); the child is `.child` on the promise.
 */
export function runWithTimeout(command, { timeoutMs = DEFAULT_MINUTES * 60_000, env = process.env, cwd } = {}) {
  const windows = process.platform === 'win32',
    child = Array.isArray(command)
      ? spawn(command[0], command.slice(1), { cwd, env, stdio: 'inherit', detached: !windows })
      : spawn(command, { cwd, env, stdio: 'inherit', shell: true, detached: !windows });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child.pid);
  }, timeoutMs);
  const result = new Promise((done) => {
    const finish = (code) => {
      clearTimeout(timer);
      done({ code: timedOut ? 124 : (code ?? 1), timedOut });
    };
    child.once('error', () => finish(1));
    child.once('close', finish);
  });
  result.child = child;
  return result;
}

export const USAGE = `usage: node scripts/run-with-timeout.mjs [run] [--max=<min>] -- <command...>

Runs the command at once and ends its whole process tree after --max minutes (default ${DEFAULT_MINUTES}), exiting 124.
No GPU lock is used, ever. The \`run\` verb is optional; any other flag before -- is ignored, so a tool outside this
repository that still passes an old flag keeps working.

Example:
  node scripts/run-with-timeout.mjs --max=10 -- node packages/sky/test/browser-check.mjs`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const all = process.argv.slice(2),
    args = all[0] === 'run' ? all.slice(1) : all,
    split = args.indexOf('--'),
    flags = args.slice(0, split < 0 ? args.length : split);
  if (!showHelp(USAGE, flags)) {
    const command = split < 0 ? [] : args.slice(split + 1);
    const max = flags.find((a) => a.startsWith('--max='))?.slice(6),
      minutes = max === undefined ? DEFAULT_MINUTES : Number(max);
    // A usage error sets its code and ends by the event loop too, never process.exit (KB-OWN-EXIT1, KB-OWN-EXIT2).
    const usage = !command.length ? USAGE : !(minutes > 0) ? '--max must be a positive number of minutes' : '';
    if (usage) {
      console.error(usage);
      process.exitCode = 2;
    } else {
      const running = runWithTimeout(process.platform === 'win32' ? windowsCommandLine(command) : command, {
        timeoutMs: minutes * 60_000,
      });
      const interrupted = () => {
        killTree(running.child.pid);
        process.exit(130); // process.exit: an interrupt ends the wrapper at once, its command tree already killed
      };
      const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
      for (const signal of signals) process.on(signal, interrupted);
      const { code, timedOut } = await running;
      for (const signal of signals) process.off(signal, interrupted);
      if (timedOut) console.error(`TIMEOUT after ${+minutes.toFixed(2)} min: ${command.join(' ')}`);
      // Ends by its event loop, never process.exit (KB-OWN-EXIT1: process.exit can hang joining V8's worker threads).
      process.exitCode = code;
    }
  }
}
