import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));

const context = await openBrowser({ startPath: '/packages/ui/tests/text-input.html', port: 'free' });
const { page, hardware } = context,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.setDefaultTimeout(60_000);
try {
  await page.waitForFunction(() => window.textTest);
  const pixels = await page.evaluate(() => window.textTest.frame());
  assert.ok(pixels.bright > 15, `actual rendered text pixels: ${pixels.bright}`);
  await page.mouse.click(80, 42);
  assert.equal(
    await page.locator('[data-margo-text-input=name]').evaluate((el) => el === document.activeElement),
    true,
    'canvas click focuses native editor',
  );
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Ada Lovelace');
  assert.equal((await page.evaluate(() => window.textTest.state())).value, 'Ada Lovelace');
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+ArrowRight');
  let state = await page.evaluate(() => window.textTest.state());
  assert.equal(state.end - state.start, 1);
  await page.keyboard.type('E');
  assert.equal((await page.evaluate(() => window.textTest.state())).value, 'Eda Lovelace');
  await page.keyboard.press('ControlOrMeta+Z');
  assert.equal((await page.evaluate(() => window.textTest.state())).value, 'Ada Lovelace', 'native undo preserved');
  await page.keyboard.press('Enter');
  assert.equal((await page.evaluate(() => window.textTest.state())).submitted, 1);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('ControlOrMeta+C');
  await page.keyboard.press('Tab');
  await page.keyboard.press('ControlOrMeta+V');
  assert.equal(
    await page.evaluate(() => window.textTest.password.value),
    'Ada Lovelace',
    'real native clipboard paste',
  );
  const masked = await page.evaluate(() => {
    window.textTest.ui.update(0);
    return window.textTest.ui
      .draw()
      .commands.filter((c) => c.type === 'text')
      .map((c) => c.layout.text);
  });
  assert.ok(masked.includes('••••••••••••'), 'password drawn as bullets');
  await page.keyboard.press('Tab');
  assert.equal((await page.evaluate(() => window.textTest.state())).focused, 'message');
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('First');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second');
  assert.equal(await page.evaluate(() => window.textTest.area.value), 'First\nSecond');
  // Chrome DevTools IME path goes through the browser editing engine, not synthetic input events.
  const cdp = await page.context().newCDPSession(page);
  await page.keyboard.press('ControlOrMeta+A');
  await cdp.send('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 });
  assert.equal(await page.evaluate(() => window.textTest.area.composing), true);
  assert.equal(await page.evaluate(() => window.textTest.area.value), '日本');
  await cdp.send('Input.insertText', { text: '日本語' });
  assert.equal(await page.evaluate(() => window.textTest.area.value), '日本語');
  assert.equal(await page.evaluate(() => window.textTest.area.composing), false);
  await cdp.detach();
  await page.keyboard.press('Tab');
  assert.equal((await page.evaluate(() => window.textTest.state())).focused, 'done');
  await page.keyboard.press('Shift+Tab');
  assert.equal((await page.evaluate(() => window.textTest.state())).focused, 'message');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  assert.equal(
    await page.evaluate(() => document.activeElement.id),
    'after',
    'Tab leaves the entire UI after its final widget',
  );
  // Drag, including outside the text box, selects from canvas coordinates.
  await page.evaluate(() => {
    window.textTest.name.value = 'hello world';
    window.textTest.ui.update(0);
  });
  await page.mouse.move(33, 42);
  await page.mouse.down();
  await page.mouse.move(500, 42);
  await page.mouse.up();
  state = await page.evaluate(() => window.textTest.state());
  assert.equal(state.end, 11);
  assert.ok(state.start < state.end);
  const drawn = await page.evaluate(() => window.textTest.frame());
  assert.ok(drawn.commands.includes('clip'));
  const highContrast = await page.evaluate(async () => {
    const t = window.textTest;
    t.ui.theme = t.themes.highContrast;
    t.name.value = 'MMMM';
    t.ui.focus(t.name, 'keyboard');
    t.name.select();
    return t.frame();
  });
  assert.ok(
    highContrast.selectedBlack > 5 && highContrast.selectedYellow > 5,
    `selected glyphs are black on yellow on the GPU: ${JSON.stringify(highContrast)}`,
  );
  await mkdir('test-results', { recursive: true });
  const mode = compatRun() ? 'compat' : 'native';
  await page.screenshot({ path: `test-results/ui-text-input-${mode}.png` });
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.textTest.close());
  await writeFile(
    `test-results/ui-text-input-${mode}.json`,
    JSON.stringify(
      {
        hardware,
        mode,
        pixels,
        highContrast,
        checks: [
          'rendered canvas text',
          'real canvas focus',
          'editing and selection',
          'native undo',
          'submit',
          'native clipboard',
          'masked password',
          'Tab interoperability',
          'reverse Tab and leaving UI',
          'high contrast selected pixels',
          'multiline Enter',
          'browser IME composition',
          'drag beyond field',
          'cleanup',
        ],
      },
      null,
      2,
    ),
  );
  console.log(`14 text input browser checks passed (${mode})`);
} finally {
  await context.close();
}
