import { openBrowser } from '../../../../scripts/browser.js';

// BROWSER_EXECUTABLE names Firefox in this matrix. The shared Chromium helper
// also honors that variable, so omit it for the native reference launch only.
export async function openNativeOracle(options, open = openBrowser) {
  const executable = process.env.BROWSER_EXECUTABLE;
  delete process.env.BROWSER_EXECUTABLE;
  try {
    return await open(options);
  } finally {
    if (executable !== undefined) process.env.BROWSER_EXECUTABLE = executable;
    else delete process.env.BROWSER_EXECUTABLE;
  }
}
