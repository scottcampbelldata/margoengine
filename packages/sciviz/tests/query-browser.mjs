import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-query.html', port: 'free', compat });
  const errors = []; browser.page.on('pageerror', (e) => errors.push(e.message)); browser.page.setDefaultTimeout(120000);
  try {
    await browser.page.waitForFunction(() => document.querySelector('#status').dataset.ready === 'true');
    const result = await browser.page.evaluate(async () => {
      const demo = await import('/examples/sciviz-query.ts');
      const { Spreadsheet, QuerySelection } = await import('/packages/sciviz/dist/query.js');
      const { ColumnarTable } = await import('/packages/sciviz/dist/table.js');
      const check = (value, message) => { if (!value) throw new Error(message); };
      demo.figure.engine.stop(); demo.tmrFigure.engine.stop();
      const hash = async (figure) => { const bitmap = await createImageBitmap(await figure.toPNG()); const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close(); let hash = 0; for (const v of ctx.getImageData(0, 0, canvas.width, canvas.height).data) hash = Math.imul(hash, 31) + v | 0; return hash; };
      const expected = [...demo.query.table.column('tmax').values].flatMap((v, i) => v > .9 * Math.max(...demo.query.table.column('tmax').values) ? [i] : []);
      check(JSON.stringify([...demo.query.rows()]) === JSON.stringify(expected), 'real GHCN query selects exact physical observations');
      const before = await hash(demo.figure), nasa = await hash(demo.tmrFigure);
      check(demo.tmr.rows().length > 0 && demo.tmr.rows().length < demo.tmr.table.length, 'NASA TMR solution is queried');
      demo.sheet.sort('tmax', true); check(demo.query.table.value('tmax', demo.sheet.rows[0]) === Math.max(...demo.query.table.column('tmax').values), 'spreadsheet numeric descending sort');
      demo.sheet.element.querySelector('[data-row]').click(); await demo.ready(); check(demo.query.rows().length === 1, 'sorted spreadsheet row click publishes original key');
      demo.query.selection.undo(); await demo.ready(); check(demo.query.rows().length === expected.length, 'undo restores query selection');
      demo.query.select('tmax < min(tmax) + 5'); await demo.ready(); const after = await hash(demo.figure); check(before !== after, 'selection updates time plot pixels ' + JSON.stringify({before,after,rows:[...demo.query.rows()],layers:demo.figure.layers.map(v=>({kind:v.kind,bounds:v.bounds,positions:[...v.positions].slice(0,9)})),svg:(await demo.figure.toSVG()).slice(0,300)}));
      check(demo.query.extract().length === demo.query.rows().length, 'extraction follows linked selection');
      const table = new ColumnarTable(Object.fromEntries(Array.from({ length: 80 }, (_, j) => ['c' + j, Float64Array.from({ length: 100000 }, (_, i) => i + j)])));
      using query = new QuerySelection(table);
      const container = document.createElement('div'); container.style.width = '400px'; document.body.append(container);
      const abort = new AbortController(); using sheet = new Spreadsheet(container, query, { height: 140, signal: abort.signal });
      check(sheet.element.querySelectorAll('[data-row]').length < 20 && sheet.element.querySelectorAll('[role=gridcell]').length < 150, '100k by 80 grid is virtualised on both axes');
      sheet.element.scrollTop = 28 * 99990; sheet.element.scrollLeft = 160 * 70; sheet.render();
      check(Number(sheet.element.querySelector('[data-row]').dataset.row) > 99980 && sheet.element.querySelector('[role=columnheader]').textContent === 'c69', 'deep row and horizontal column scroll');
      check(!sheet.element.hasAttribute('aria-activedescendant'), 'virtualising away the focused cell removes its stale ARIA reference');
      sheet.sort('c0', true); sheet.element.scrollTop = 0; sheet.element.scrollLeft = 0; sheet.render();
      sheet.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); sheet.element.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      check(query.selection.rowIds[0] === 99998, 'keyboard navigation selects source identity after sort');
      sheet.selectedOnly = true; check(sheet.rows.length === 1, 'selected-only spreadsheet');
      abort.abort(); check(!container.children.length, 'abort removes the view and listeners'); container.remove();
      demo.sheet.dispose(); demo.tmrSheet.dispose(); demo.figure.dispose(); demo.tmrFigure.dispose(); demo.query.dispose(); demo.tmr.dispose();
      return { expected: expected.length, before, after, nasa, virtualRows: 100000, virtualColumns: 80 };
    });
    assert.deepEqual(errors, []); console.log(JSON.stringify({ compat, ...result }));
  } finally { await browser.close(); }
}
