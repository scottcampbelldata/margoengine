// A suite whose browser close never finishes (KB-P3h): its host never acknowledges the end and its client close never
// returns. Like scripts/visual-regression.js it reports the close error and goes on, then ends on its own, with no
// process.exit: it can end only if the close left nothing of the browser referenced. Prints one JSON line with the
// host and browser pids, then one with the close outcome. Argument: the close limit in ms.
import { fileURLToPath } from 'node:url';
import { startHost, withBoundedClose } from '../../scripts/lib/browser.mjs';

const budgetMs = Number(process.argv[2] ?? 1000);
const host = await startHost({}, { hostPath: fileURLToPath(new URL('hung-browser-host.mjs', import.meta.url)) });
console.log(JSON.stringify({ host: host.process.pid, browser: host.pid }));
const browser = withBoundedClose(
  { close: () => new Promise(() => {}) },
  { host, budgetMs, listMs: 50, report: () => {} },
);
try {
  await browser.close();
  console.log(JSON.stringify({ closed: true }));
} catch (error) {
  console.log(
    JSON.stringify({
      code: error.code,
      killed: error.killed,
      survivors: error.survivors,
      open: error.open,
      message: error.message,
    }),
  );
}
