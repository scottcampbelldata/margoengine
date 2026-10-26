// Real-GPU checks of @margoengine/ui (one GPU job at a time; from the repository root after building packages):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/ui/tests/ui-browser.mjs
// The page (ui-browser.js) draws a card with a button, a health bar, labels and a clipped scrolling list through the
// real UiRenderer, reads the canvas back, and checks colours, rounded corners, shadows, text, clipping, dialogs
// dimming the screen, resolution scaling, themes, and that an unchanged frame uploads nothing. Results go to
// test-results/ui-browser.json.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

// The dev server serves the repository root, whichever folder `npm run test:browser` starts in.
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));

const context = await openBrowser({ startPath: '/packages/ui/tests/ui.html', port: 5251 });
const { page, hardware } = context;
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.setDefaultTimeout(120_000);
try {
  await page.waitForFunction(() => typeof window.runUiTests === 'function');
  const report = await page.evaluate(() => window.runUiTests());
  assert.deepEqual(errors, []);
  // Real mouse and keyboard input through the canvas listeners that UiRenderer attached.
  const rect = await page.evaluate(() => window.setupInputTest());
  const cx = rect.x + rect.width / 2,
    cy = rect.y + rect.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.up();
  let state = await page.evaluate(() => window.readInputState());
  assert.equal(state.clicks, 1, 'a real click presses the button');
  assert.equal(state.gameDown, 0, 'the click did not reach the game listeners on the canvas');
  assert.equal(state.focused, 'go');
  assert.equal(state.focusVisible, false, 'a mouse click shows no focus ring');
  report.checks.push('a real mouse click presses a button, is kept from the game and shows no focus ring');
  await page.mouse.click(400, 300);
  state = await page.evaluate(() => window.readInputState());
  assert.equal(state.gameDown, 1, 'a press on empty space reaches the game');
  assert.equal(state.focused, null);
  report.checks.push('a real click on empty space reaches the game and clears the UI focus');
  await page.locator('canvas').focus();
  await page.keyboard.press('Tab');
  state = await page.evaluate(() => window.readInputState());
  assert.equal(state.focused, 'go', 'Tab focuses the first widget');
  assert.equal(state.focusVisible, true);
  assert.equal(state.mode, 'keyboard');
  const [r, g, b] = state.ring;
  assert.ok(
    Math.abs(r - 240) < 30 && Math.abs(g - 228) < 30 && Math.abs(b - 66) < 60,
    `the focus ring is drawn in the focus colour: ${state.ring}`,
  );
  await page.keyboard.press('Enter');
  state = await page.evaluate(() => window.readInputState());
  assert.equal(state.clicks, 2, 'Enter presses the focused button');
  report.checks.push('real Tab shows a visible focus ring in the theme focus colour and Enter presses the button');
  await page.keyboard.press('Tab');
  state = await page.evaluate(() => window.readInputState());
  assert.equal(state.focused, null, 'Tab past the last widget hands focus back to the page');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/ui-browser.png' });
  const after = await page.evaluate(() => window.finishInputTest());
  assert.equal(after.clicks, 2);
  report.checks.push('Tab past the last widget leaves the UI so the keyboard is never trapped');
  assert.deepEqual(errors, []);
  // The site demo: the title menu with the keyboard, then play, take damage with a game key, and pause.
  await page.goto(new URL('/examples/ui-game.html', page.url()).href);
  await page.waitForFunction(() => document.querySelector('#viewport')?.dataset.ready === 'true', null, {
    timeout: 120_000,
  });
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.uiDemo.screen()), 'title');
  await page.screenshot({ path: 'test-results/ui-game-title.png' });
  await page.locator('canvas').focus();
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => window.uiDemo.ui.focused?.text === 'Play');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.uiDemo.screen() === 'play');
  await page.waitForTimeout(300);
  await page.keyboard.press('d');
  await page.waitForFunction(() => window.uiDemo.health() === 80);
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'test-results/ui-game-play.png' });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.uiDemo.screen() === 'pause');
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/ui-game-pause.png' });
  const mirror = await page.evaluate(() =>
    [...document.querySelectorAll('[data-margo-ui=mirror] button')].map((b) => b.textContent),
  );
  assert.deepEqual(
    mirror.slice(0, 3),
    ['Resume', 'Settings', 'Quit to title'],
    'the pause menu is in the screen reader mirror',
  );
  assert.deepEqual(errors, []);
  report.checks.push(
    'the site demo starts, plays with the keyboard, takes damage, pauses, and mirrors the menu for screen readers',
  );
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/ui-browser.json', JSON.stringify({ hardware, ...report }, null, 2));
  for (const name of report.checks) console.log(`ok - ${name}`);
  console.log(`${report.checks.length} ui browser checks passed`);
} finally {
  await context.close();
}
