// Runs tests/gpu-browser.js on a real GPU in a real browser, from the repository root after building packages, holding
// the GPU lock: npm run test:gpu -w packages/robot-planning (MARGO_COMPAT=1 runs it on the WebGL2 compatibility layer).
import { openBrowser } from '../../../scripts/browser.js';

const app = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' });
try {
  const report = await app.page.evaluate(async () => {
    const { gpuChecks } = await import('/packages/robot-planning/tests/gpu-browser.js');
    return gpuChecks();
  });
  for (const line of report) console.log(line);
  console.log('robot-planning GPU checks passed');
} finally {
  await app.close();
}
