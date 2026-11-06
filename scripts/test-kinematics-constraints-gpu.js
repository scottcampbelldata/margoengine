// Runs packages/kinematics-constraints/tests/gpu-browser.js on a real GPU in a real browser.
import { fileURLToPath } from 'node:url';
import { openBrowser } from './browser.js';
process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const app = await openBrowser({ startPath: '/examples/kinematics-constraints.html', port: 'free' });
try {
  const report = await app.page.evaluate(async () => {
    const { gpuChecks } = await import('/packages/kinematics-constraints/tests/gpu-browser.js');
    return gpuChecks();
  });
  for (const line of report) console.log(line);
} finally {
  await app.close();
}
