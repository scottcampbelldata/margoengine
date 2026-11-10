import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const browser = await openBrowser({ startPath: '/examples/ui-editor/', port: 'free' }),
  { page } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.setDefaultTimeout(60000);
try {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForFunction(
    () => window.layoutEditor?.renderer.stats.drawCalls > 0 && window.layoutEditor.renderer.stats.glyphs > 0,
  );
  const labelPoint = await page.evaluate(() => {
    const t = window.layoutEditor,
      r = t.ui.find('planet').rect,
      c = t.engine.canvas.getBoundingClientRect();
    return { x: c.left + (r.x + r.width / 2) * t.ui.cssScale, y: c.top + (r.y + r.height / 2) * t.ui.cssScale };
  });
  await page.mouse.click(labelPoint.x, labelPoint.y);
  assert.equal(
    await page.getByRole('textbox', { name: 'Selected text', exact: true }).inputValue(),
    'Mars',
    'noninteractive label can be selected in the preview',
  );
  const tree = page.getByRole('treeitem', { name: 'label #planet', exact: true });
  await tree.click();
  await page.getByRole('textbox', { name: 'Selected text', exact: true }).fill('Earth');
  await page.getByRole('textbox', { name: 'Selected text', exact: true }).press('Tab');
  await page.waitForFunction(() => window.layoutEditor.editor.document.build().get('planet').text === 'Earth');
  const sheet = page.getByRole('textbox', { name: 'Style sheet', exact: true });
  await sheet.fill('.menu { width: 360; padding: 24; gap: 12; background: surface; }');
  assert.match(await page.evaluate(() => window.layoutEditor.editor.document.source.styles), /width: 360/);
  const markup = page.getByRole('textbox', { name: 'Markup', exact: true }),
    valid = await markup.inputValue();
  await markup.fill('<panel>');
  assert.match(await page.locator('output').textContent(), /Markup/);
  assert.equal(await page.evaluate(() => window.layoutEditor.editor.document.build().get('planet').text), 'Earth');
  // Saving a broken draft must fail visibly instead of silently exporting the previous valid source.
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  assert.match(await page.locator('output').textContent(), /Markup/);
  await markup.fill(valid);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  const download = await downloadPromise;
  await download.saveAs('test-results/batch259-editor-layout.json');
  const saved = await readFile('test-results/batch259-editor-layout.json', 'utf8'),
    project = JSON.parse(saved);
  assert.equal(project.version, 1);
  assert.match(project.markup, /Earth/);
  assert.match(project.styles, /width: 360/);
  await page.locator('input[type=file]').setInputFiles({
    name: 'layout.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...project, markup: project.markup.replace('Earth', 'Mars') })),
  });
  await page.waitForFunction(() => window.layoutEditor.editor.document.build().get('planet').text === 'Mars');
  await page.screenshot({ path: 'test-results/batch259-editor-desktop.png', fullPage: true });
  for (const width of [1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => {
            window.layoutEditor.engine.render(0);
            resolve();
          }),
        ),
    );
    const dimensions = await page.evaluate(() => ({
      width: innerWidth,
      page: document.documentElement.scrollWidth,
      overflow: [...window.layoutEditor.editor.element.shadowRoot.querySelectorAll('*')]
        .map((e) => {
          const r = e.getBoundingClientRect();
          return { tag: e.tagName, class: e.className, right: r.right, width: r.width };
        })
        .filter((r) => r.right > innerWidth + 1),
      outside: [...document.querySelectorAll('*')]
        .map((e) => {
          const r = e.getBoundingClientRect();
          return { tag: e.tagName, class: e.className, right: r.right, width: r.width };
        })
        .filter((r) => r.right > innerWidth + 1),
    }));
    assert.equal(
      dimensions.page <= dimensions.width,
      true,
      `no page overflow at ${width}: ${JSON.stringify(dimensions)}`,
    );
  }
  await page.screenshot({ path: 'test-results/batch259-editor-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.layoutEditor.close());
  console.log(
    'Editor preview, visual properties, live sources, invalid-draft preservation, real save/open and responsive checks passed',
  );
} finally {
  await browser.close();
}
