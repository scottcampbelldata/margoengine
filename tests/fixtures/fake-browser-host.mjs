// A browser host (scripts/support/browser-host.mjs) whose "browser" is a plain Node child with Chromium's five pipes
// that runs until ended, or, with `stuck: true` in its settings, a fake child the kernel never finishes with (its exit
// never arrives, like a browser process still being torn down). `fail: true` makes the launch itself fail. For
// tests/browser-host.test.js: the suite side (`startHost`) is exercised against a real host process without a browser.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { hostBrowser } from '../../scripts/support/browser-host.mjs';

const settings = JSON.parse(process.argv[2] ?? '{}');
const launchServer = async (options) => {
  if (options.fail) throw new Error('browserType.launchServer: no such browser');
  let child;
  if (options.stuck) {
    child = Object.assign(new EventEmitter(), {
      pid: 4_000_000,
      exitCode: null,
      signalCode: null,
      stdio: [],
      kill(signal) {
        this.signalCode = signal;
        return true;
      },
    });
  } else {
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    await new Promise((resolve, reject) => child.once('spawn', resolve).once('error', reject));
  }
  return { process: () => child, wsEndpoint: () => 'ws://127.0.0.1:1/fake', kill: async () => {} };
};
process.exitCode = await hostBrowser({ settings, launchServer, reapMs: settings.reapMs, logFile: settings.logFile });
process.exit(process.exitCode);
