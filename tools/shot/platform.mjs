// What differs between the machines a shot renders on (Windows and macOS): which browser renders it, and where the
// output goes. Plain functions of the platform and the environment, so the unit test checks both platforms anywhere.
import { join } from 'node:path';

/**
 * The browser a shot renders in, as scripts/lib/browser.mjs names them. MARGO_BROWSER (or `--browser=`) wins; else
 * Edge on Windows (Chrome with MARGO_BROWSER=chrome) and Chrome on macOS, both installed browsers driven by the
 * repository's Playwright. Linux, a test runner, keeps Playwright's own Chromium.
 */
export function shotBrowser({ platform = process.platform, env = process.env, argv = process.argv } = {}) {
  const asked = argv.find((arg) => arg.startsWith('--browser='))?.slice('--browser='.length) ?? env.MARGO_BROWSER;
  if (asked) return String(asked).trim().toLowerCase();
  if (platform === 'win32') return 'edge';
  if (platform === 'darwin') return 'chrome';
  return 'chromium';
}

/** Today's date on this machine as YYYY-MM-DD, the name of the day's output folder. */
export function today(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Where a shot's output goes: one folder per day under `root` (MARGO_SHOT_OUT, else test-results/shots in the
 * repository). In it, `<id>/` holds the frames and manifest, and the encoder (P3) writes `<id>.mp4` beside it, with
 * the same-name `<id>.txt` (title, caption, hashtags) from the variation system.
 */
export function shotOutput(id, { repo, day = today(), env = process.env } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RangeError(`day must be YYYY-MM-DD, got "${day}"`);
  const folder = join(env.MARGO_SHOT_OUT || join(repo, 'test-results', 'shots'), day);
  return { day, folder, frames: join(folder, id), master: `${id}.mp4`, caption: `${id}.txt` };
}
