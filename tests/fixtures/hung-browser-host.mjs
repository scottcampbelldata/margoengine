// A browser host (scripts/support/browser-host.mjs) that is stuck: it starts a "browser" (a plain Node child that runs
// until killed), reports it ready like the real host, then never answers an end request and never ends by itself, also
// when its stdin closes. For the close limit in tests/browser-teardown.test.js (KB-P3h): only a kill ends this tree.
import { spawn } from 'node:child_process';

const browser = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
await new Promise((resolve, reject) => browser.once('spawn', resolve).once('error', reject));
process.stdout.write(`${JSON.stringify({ ready: true, wsEndpoint: 'ws://127.0.0.1:1/hung', pid: browser.pid })}\n`);
// Reads and drops every request, so the suite's writes never fill the pipe; answers nothing.
process.stdin.on('data', () => {});
process.stdin.on('error', () => {});
setInterval(() => {}, 1000);
