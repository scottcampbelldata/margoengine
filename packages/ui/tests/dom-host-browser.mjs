import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const browser = await openBrowser({ startPath: '/packages/ui/tests/dom-host.html', port: 'free' }),
  { page } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.setDefaultTimeout(60000);
const log = () => page.evaluate(() => window.domTest.log.splice(0));
const focusedId = () =>
  page.evaluate(() => window.domTest.host.widgetOf(document.activeElement)?.id ?? document.activeElement?.id);
const value = (name) => page.evaluate((name) => window.domTest.widgets[name].value, name);
try {
  await page.waitForFunction(() => window.domTest);
  // Tab order is the widget order: the disabled button is skipped, a listbox and a tablist are one tab stop each.
  await page.keyboard.press('Tab');
  const order = [];
  for (let i = 0; i < 12; i++) {
    order.push(await focusedId());
    await page.keyboard.press('Tab');
  }
  const listStop = order[4];
  assert.match(listStop, /^w\d+$/, `the first option is the listbox's tab stop: ${order}`);
  assert.deepEqual(order, [
    'make',
    'stills',
    'answer',
    'send',
    listStop,
    'sound',
    'volume',
    'quality',
    'tabs-choice-0',
    'tabs-panel-0',
    'back',
    'after',
  ]);
  // Enter and Space activate buttons; arrows move through the listbox and Enter selects.
  await page.locator('#margo-dom-make').focus();
  await page.keyboard.press('Enter');
  await page.locator('#margo-dom-stills').focus();
  await page.keyboard.press(' ');
  assert.deepEqual(await log(), ['make', 'stills']);
  await page.getByRole('option').first().focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Camera lower');
  await page.keyboard.press('Enter');
  assert.deepEqual(await log(), ['changes:1']);
  await page.waitForFunction(() => document.querySelectorAll('[role=option][aria-selected=true]').length === 1);
  // Typing, then an IME composition: the widget follows the native field.
  const answer = page.locator('#margo-dom-answer');
  await answer.fill('Brighter sky');
  assert.equal(await value('answer'), 'Brighter sky');
  await answer.fill('');
  await answer.focus();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 });
  assert.equal(await page.evaluate(() => window.domTest.widgets.answer.composing), true);
  await cdp.send('Input.insertText', { text: '日本語' });
  assert.equal(await value('answer'), '日本語');
  assert.equal(await page.evaluate(() => window.domTest.widgets.answer.composing), false);
  // The switch, the range input and the select are native controls.
  await page.getByRole('switch', { name: 'Sound' }).click();
  assert.equal(await page.evaluate(() => window.domTest.widgets.sound.checked), true);
  await page.getByRole('slider', { name: 'Volume' }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await value('volume'), 6);
  await page.getByRole('combobox', { name: 'Quality' }).selectOption('final');
  assert.equal(await value('quality'), 'final');
  // Tabs: arrows select and move focus (automatic activation).
  await page.getByRole('tab', { name: 'Shots' }).focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute('aria-selected') === 'true' &&
      document.activeElement.textContent === 'Notes',
  );
  assert.equal(await page.getByRole('tabpanel').count(), 1);
  // A modal <dialog>: focus moves in, the page behind is inert, Escape cancels.
  await page.locator('#margo-dom-back').focus();
  const result = page.evaluate(() =>
    window.domTest.ui.dialog({
      title: 'Leave?',
      message: 'Your answer is kept.',
      buttons: [
        { label: 'Leave', value: 'leave' },
        { label: 'Stay', value: 'stay' },
      ],
      cancelValue: 'stay',
    }),
  );
  await page.waitForFunction(() => document.querySelector('dialog')?.open);
  await page.waitForFunction(() => document.activeElement?.closest('dialog'));
  assert.equal(await page.evaluate(() => document.querySelector('dialog').matches(':modal')), true);
  await page.keyboard.press('Escape');
  assert.equal(await result, 'stay');
  await page.waitForFunction(() => !document.querySelector('dialog'));
  // The accessibility tree of the whole page.
  const snapshot = await page.locator('#app').ariaSnapshot();
  for (const line of [
    'region "Review"',
    'group "Make strip"',
    'button "Make"',
    'button "Cut" [disabled]',
    'textbox "Change this"',
    'listbox "What changed"',
    'option "Camera lower" [selected]',
    'switch "Sound" [checked]',
    'slider "Volume"',
    'combobox "Quality"',
    'tablist "Views"',
    'tab "Notes" [selected]',
    'button "Go back"',
  ])
    assert.ok(snapshot.includes(line), `aria snapshot has ${line}:\n${snapshot}`);
  // Targets are at least 44 by 44 CSS pixels and themed through the shared stylesheet, which the strict CSP allowed.
  for (const id of ['make', 'send', 'back']) {
    const box = await page.locator(`#margo-dom-${id}`).boundingBox();
    assert.ok(box.width >= 44 && box.height >= 44, `${id} is ${box.width} by ${box.height}`);
  }
  const [button, primary] = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = window.domTest.ui.theme.colors.primary;
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return [getComputedStyle(document.getElementById('margo-dom-make')).backgroundColor, c];
  });
  assert.equal(button, primary, 'the primary button has the theme colour');
  assert.deepEqual(await page.evaluate(() => window.domTest.violations), []);
  // Unmounting removes every element.
  await page.evaluate(() => window.domTest.host.dispose());
  assert.equal(await page.evaluate(() => document.getElementById('app').children.length), 0);
  assert.deepEqual(errors, []);
  console.log('dom host browser: ok');
} finally {
  await browser.close();
}
