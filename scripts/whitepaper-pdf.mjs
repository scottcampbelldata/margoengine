// Prints the engine whitepaper to site/whitepaper/engine.pdf with the page's own print styles (whitepaper.css
// @media print), in headless Edge (or bundled Chromium). No GPU needed. Run after editing site/whitepaper/engine.html:
//   node scripts/whitepaper-pdf.mjs [page ...]      default: engine
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const root = resolve(import.meta.dirname, '..'),
  pages = process.argv.slice(2).length ? process.argv.slice(2) : ['engine'];
const browser = await chromium
  .launch({ channel: process.env.BROWSER_CHANNEL ?? 'msedge', headless: true })
  .catch(() => chromium.launch({ headless: true }));
try {
  const page = await browser.newPage();
  await page.emulateMedia({ media: 'print', colorScheme: 'light' });
  for (const name of pages) {
    const html = resolve(root, 'site/whitepaper', `${name}.html`),
      pdf = resolve(root, 'site/whitepaper', `${name}.pdf`);
    await page.goto(pathToFileURL(html).href);
    await page.pdf({
      path: pdf,
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate:
        '<div style="font:8px system-ui,sans-serif;color:#4a556b;width:100%;padding:0 15mm;display:flex;justify-content:space-between"><span class="title"></span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
    });
    console.log(pdf);
  }
} finally {
  await browser.close();
}
