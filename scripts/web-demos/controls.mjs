#!/usr/bin/env node
// Drives every control of built web demos in installed Chrome, on WebGPU and on ?backend=webgl2, and reports any control that
// changes nothing: node scripts/web-demos/controls.mjs <demo...> [--out=<dir>] [--backends=webgpu,webgl2]
//
// For each visible, enabled control (range, select, checkbox, radio, button, number input) the page's state is read before and
// after the control is used: every data attribute in the page, the visible text and a hash of the largest canvas's pixels. A
// control that changes none of them is dead. Ranges are set to five values across their span, selects to each option, toggles
// flipped, buttons clicked (a button that starts motion is clicked again to stop it). Console errors and page errors are listed
// too. Exit code 1 when any demo fails to start, logs an error or has a dead control. A screenshot after each control goes in
// --out (default .lane/controls) so the frames can be judged.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const names = args.filter((a) => !a.startsWith('--'));
const option = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const out = path.resolve(option('out', '.lane/controls'));
const backends = option('backends', 'webgpu,webgl2').split(',');
if (names.length) await drive();
else {
  // A usage error ends with code 2 by the event loop, as every script does (KB-OWN-EXIT2).
  console.error('usage: node scripts/web-demos/controls.mjs <demo...> [--out=<dir>] [--backends=webgpu,webgl2]');
  process.exitCode = 2;
}

async function drive() {
  fs.mkdirSync(out, { recursive: true });
  const root = path.resolve('demos');
  const types = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.wasm': 'application/wasm',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
    '.md': 'text/markdown',
  };
  const server = http
    .createServer((req, res) => {
      const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory())
        return res.writeHead(404).end();
      res
        .writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' })
        .end(fs.readFileSync(file));
    })
    .listen(0);
  const port = server.address().port;
  const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu'] });
  let failed = false;
  const report = {};

  /** Data attributes, visible text and the largest canvas's pixels, as one comparable record. */
  async function state(page) {
    const page_ = await page.evaluate(() => {
      const data = [];
      for (const el of document.querySelectorAll('*'))
        for (const [k, v] of Object.entries(el.dataset))
          if (!/^(ready|state)$/.test(k)) data.push(`${el.id || el.tagName}.${k}=${v}`);
      const text = [...document.querySelectorAll('body *')]
        .filter((e) => !e.children.length && e.offsetParent !== null && e.textContent.trim())
        .map((e) => e.textContent.trim());
      const pressed = [...document.querySelectorAll('[aria-pressed],[aria-checked],[aria-expanded]')].map(
        (e) =>
          `${e.id}:${e.getAttribute('aria-pressed')}${e.getAttribute('aria-checked')}${e.getAttribute('aria-expanded')}`,
      );
      const canvases = [...document.querySelectorAll('canvas')];
      const big = canvases.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
      if (big) big.dataset.controlsProbe = '1';
      return { data: data.join('|'), text: text.join('|'), pressed: pressed.join('|') };
    });
    const canvas = await page.$('canvas[data-controls-probe]');
    const pixels = canvas
      ? crypto
          .createHash('sha1')
          .update(await canvas.screenshot())
          .digest('hex')
      : '';
    return { ...page_, pixels };
  }
  const same = (a, b) => a.data === b.data && a.text === b.text && a.pressed === b.pressed && a.pixels === b.pixels;
  const settle = (page, ms = 350) => page.waitForTimeout(ms);

  for (const name of names) {
    for (const backend of backends) {
      const key = `${name}@${backend}`;
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const errors = [];
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      page.on('pageerror', (e) => errors.push(String(e)));
      const query = backend === 'webgl2' ? '?backend=webgl2' : '';
      await page.goto(`http://127.0.0.1:${port}/${name}/index.html${query}`);
      const started = await page
        .waitForFunction(
          () =>
            document.querySelector('[data-ready],[data-error]') ||
            ['ready', 'error'].includes(document.body.dataset.state),
          null,
          { timeout: 30000 },
        )
        .then(() =>
          page.evaluate(() => document.body.dataset.state !== 'error' && !document.querySelector('[data-error]')),
        )
        .catch(() => false);
      await settle(page, 800);
      const renderer = await page.evaluate(() => document.body.dataset.renderer ?? null);
      const controls = await page.$$eval('input:not([type=hidden]), select, button, [role=switch], [role=tab]', (els) =>
        els.map((e, i) => {
          e.dataset.controlsIndex = String(i);
          const visible = e.offsetParent !== null && getComputedStyle(e).visibility !== 'hidden';
          return {
            index: i,
            tag: e.tagName.toLowerCase(),
            type: e.type ?? '',
            id: e.id || e.getAttribute('aria-label') || e.textContent.trim().slice(0, 30),
            usable: visible && !e.disabled,
          };
        }),
      );
      const results = [],
        tested = new Set();
      // A control another one reveals (a button shown in one view) is tested on a later pass.
      for (let pass = 0; pass < 3; pass++)
        for (const control of controls) {
          if (tested.has(control.index)) continue;
          const handle = await page.$(`[data-controls-index="${control.index}"]`);
          if (
            !(await handle.evaluate(
              (e) => e.offsetParent !== null && !e.disabled && getComputedStyle(e).visibility !== 'hidden',
            ))
          )
            continue;
          tested.add(control.index);
          const before = await state(page);
          let changed = false;
          if (control.tag === 'input' && (control.type === 'range' || control.type === 'number')) {
            const [min, max, step] = await handle.evaluate((e) => [
              Number(e.min || 0),
              Number(e.max || 100),
              Number(e.step) || 1,
            ]);
            for (const f of [0, 0.25, 0.5, 0.75, 1]) {
              const v = Math.round((min + (max - min) * f) / step) * step;
              await handle.evaluate((e, v) => {
                e.value = String(v);
                e.dispatchEvent(new Event('input', { bubbles: true }));
                e.dispatchEvent(new Event('change', { bubbles: true }));
              }, v);
              await settle(page, 200);
              if (!same(before, await state(page))) changed = true;
            }
          } else if (control.tag === 'select') {
            const count = await handle.evaluate((e) => e.options.length);
            for (let i = 0; i < count; i++) {
              await handle.selectOption({ index: (i + 1) % count });
              await settle(page);
              if (!same(before, await state(page))) changed = true;
            }
          } else {
            await handle.click();
            await settle(page);
            changed = !same(before, await state(page));
            // The selected option of a pressed-button group changes nothing when clicked: pick a sibling, then test it.
            const sibling = changed
              ? null
              : await handle.evaluateHandle((e) =>
                  e.getAttribute('aria-pressed') === 'true'
                    ? ([...e.parentElement.querySelectorAll(':scope > [aria-pressed]')].find(
                        (s) => s !== e && !s.disabled,
                      ) ?? null)
                    : null,
                );
            const other = sibling?.asElement();
            if (other) {
              await other.click();
              await settle(page);
              const picked = await state(page);
              await handle.click();
              await settle(page);
              changed = !same(picked, await state(page));
            }
            // A button that starts motion keeps changing the frame: click it again so the next control starts from rest.
            const moving = !same(await state(page), (await settle(page, 300), await state(page)));
            if (moving) {
              await handle.click();
              await settle(page);
            }
          }
          await page.screenshot({ path: path.join(out, `${name}-${backend}-${control.index}.png`) });
          results.push({ control: `${control.tag}${control.type ? `[${control.type}]` : ''} ${control.id}`, changed });
        }
      const dead = results.filter((r) => !r.changed).map((r) => r.control);
      const skipped = controls.filter((c) => !tested.has(c.index)).map((c) => `${c.tag} ${c.id}`);
      report[key] = { started, renderer, errors, controls: results.length, dead, skipped };
      // ?backend=webgl2 must reach the WebGL2 layer: a page that says it drew on WebGPU there ignored the query.
      const wrongPath = backend === 'webgl2' && renderer === 'webgpu';
      if (!started || errors.length || dead.length || wrongPath) failed = true;
      console.log(
        `${key}: ${started ? 'started' : 'FAILED TO START'} renderer=${renderer}${wrongPath ? ' (WRONG PATH: the query was ignored)' : ''} controls=${results.length} dead=${dead.length}` +
          `${dead.length ? ` [${dead.join(', ')}]` : ''} errors=${errors.length}${errors.length ? ` [${errors[0].slice(0, 160)}]` : ''}`,
      );
      await page.close();
    }
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
  await browser.close();
  server.close();
  process.exitCode = failed ? 1 : 0;
}
