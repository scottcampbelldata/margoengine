// KB-FILM-HEADLESS1: a step that Windows could not start. Exit status 0xC0000142 (STATUS_DLL_INIT_FAILED, 3221225794;
// [MS-ERREF] 2.3.1 NTSTATUS values) means a process failed while its DLLs initialised, before any of its own code ran.
// Under load that is the desktop heap of the session running out (Microsoft, "Desktop heap limitation causes out of
// memory error", learn.microsoft.com/troubleshoot/windows-server/performance/desktop-heap-limitation-out-of-memory):
// every process with a console or a window takes a piece of it. The process that failed prints nothing (npm said only
// "npm error code 3221225794" for `node ../../scripts/build-optional.js headless`), so the runner that sees the code
// names it, with the machine state of the moment: how many processes were running and the heap sizes the session is
// configured with. Nothing retries the step.
import { execFileSync } from 'node:child_process';

/** NTSTATUS 0xC0000142 as a process exit code. */
export const STATUS_DLL_INIT_FAILED = 0xc0000142;

/** The registry value that sets the desktop heap sizes, in KB: SharedSection=<shared>,<interactive>,<non-interactive>. */
const SUBSYSTEMS = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\SubSystems';

/**
 * The machine state when a process could not start: the running process count and the configured desktop heap
 * (SharedSection), read through `run` (execFileSync's shape). A probe that cannot run is reported as such, since under
 * a heap that has run out the probe itself may fail to start.
 */
export function startFailureState(run = execFileSync) {
  const probe = (file, args, read) => {
    try {
      return read(String(run(file, args, { encoding: 'utf8', timeout: 15_000, windowsHide: true })));
    } catch (error) {
      return `could not be read (${file} ${error?.status === STATUS_DLL_INIT_FAILED ? 'could not start either' : `failed: ${error?.code ?? error?.status ?? error?.message}`})`;
    }
  };
  const processes = probe('tasklist', ['/fo', 'csv', '/nh'], (out) => `${out.split(/\r?\n/).filter(Boolean).length}`),
    heap = probe('reg', ['query', SUBSYSTEMS, '/v', 'Windows'], (out) => {
      const match = /SharedSection=([\d,]+)/.exec(out);
      return match ? `SharedSection=${match[1]} KB` : 'not set';
    });
  return `running processes: ${processes}; desktop heap ${heap}`;
}

/**
 * The note for a step that exited with `code`, or '' when the code is not a start failure. `state` gives the machine
 * state line ({@link startFailureState}).
 */
export function startFailureNote(code, state = startFailureState) {
  if (code !== STATUS_DLL_INIT_FAILED) return '';
  return (
    'exit 0xC0000142, STATUS_DLL_INIT_FAILED: Windows could not start a process of this step (it failed while loading ' +
    'its DLLs, usually because the desktop heap ran out with many processes open; close some browsers or GPU tests ' +
    `and run it again); ${state()}. See docs/known-bugs.md (KB-FILM-HEADLESS1)`
  );
}
