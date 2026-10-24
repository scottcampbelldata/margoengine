// Writes site/errors.html (margoengine.com/errors) from scripts/errors/entries.js:
//   node scripts/errors/page.mjs          write the page
//   node scripts/errors/page.mjs --check  exit 1 if the committed page differs (tests/errors-page.test.js runs it too)
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { entries } from './entries.js';

const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const prose = (text) => escape(text).replace(/`([^`]+)`/g, '<code>$1</code>');

/** The page's HTML. */
export function errorsPage() {
  const codes = entries.filter((e) => e.kind === 'code'),
    families = entries.filter((e) => e.kind === 'family'),
    section = (e) =>
      [
        `    <section id="${e.id}">`,
        `      <h2><a href="#${e.id}">${escape(e.title)}</a></h2>`,
        e.messages.length
          ? `      <p class="messages">${e.messages.map((m) => `<code>${escape(m)}</code>`).join(' ')}</p>`
          : '',
        `      <p><strong>Cause.</strong> ${prose(e.cause)}</p>`,
        `      <p><strong>Fix.</strong> ${prose(e.fix)}</p>`,
        '    </section>',
      ]
        .filter(Boolean)
        .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Error help - Margo Engine</title>
  <meta name="description" content="What each Margo Engine error means and how to fix it. Every core error message links to its entry here.">
  <link rel="icon" href="/favicon.ico" sizes="32x32">
  <link rel="stylesheet" href="/site.css">
</head>
<body>
  <main>
    <h1>Error help</h1>
    <p>Margo Engine keeps its error messages short and ends each one with a link to its entry on this page, for
      example <code>Mesh disposed; see https://margoengine.com/errors#disposed</code>. Errors that are not a
      <code>TypeError</code> or <code>RangeError</code> are a <code>MargoError</code> with a stable <code>code</code>:
      branch on <code>error.code</code>, not on the message. Optional packages follow the same pattern.</p>
    <h2>Codes</h2>
    <ul>
${codes.map((e) => `      <li><a href="#${e.id}"><code>${e.id}</code></a></li>`).join('\n')}
    </ul>
${codes.map(section).join('\n')}
    <h2>Messages</h2>
${families.map(section).join('\n')}
    <p><a href="/">Back to margoengine.com</a></p>
  </main>
</body>
</html>
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const path = resolve(import.meta.dirname, '../../site/errors.html'),
    html = errorsPage();
  if (process.argv.includes('--check')) {
    if (readFileSync(path, 'utf8').replace(/\r\n/g, '\n') !== html) {
      console.error('site/errors.html is out of date: run node scripts/errors/page.mjs');
      process.exit(1);
    }
  } else writeFileSync(path, html);
}
