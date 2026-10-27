// The docs link checker (`npm run docs:links`, part of `npm run verify`): every relative link and image in the reader
// documentation points at a file or folder that exists, and every `#anchor` into a Markdown file names a heading in it.
// Checked: README.md and the other top-level Markdown files, docs/**/*.md, examples/**/README.md and every
// packages/*/README.md. Absolute URLs are not fetched (the check must work offline). Code fences and inline code are
// skipped, so an example that shows a link is not read as one.
//   node scripts/docs-links.mjs            check everything, print each broken link, exit 1 if there is one
//   node scripts/docs-links.mjs README.md  check only those files
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const SKIP = new Set(['node_modules', 'dist', 'test-results', '.git', '.claude', '.tmp', 'private', 'target']);

/** Markdown files of the reader documentation, as paths relative to the repository root. */
export function documents() {
  const found = [];
  const walk = (dir, accept) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path, accept);
      else if (entry.name.endsWith('.md') && accept(path)) found.push(path);
    }
  };
  for (const entry of readdirSync(root, { withFileTypes: true }))
    if (entry.isFile() && entry.name.endsWith('.md')) found.push(entry.name);
  walk('docs', () => true);
  walk('examples', (path) => path.endsWith('/README.md'));
  walk('packages', (path) => /^packages\/[^/]+\/README\.md$/.test(path));
  walk('apps', (path) => path.endsWith('/README.md') && path.split('/').length <= 3);
  return found.sort();
}

/** The anchor GitHub gives a heading: lower case, punctuation dropped, spaces to hyphens. */
export function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`|\*|_(?=\S)|\[|\]|<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

/** The text with HTML comments blanked (their lines kept), so a fence mentioned in a comment is not a fence. */
const withoutComments = (text) => text.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '));

const headingCache = new Map();
function anchors(file) {
  if (!headingCache.has(file)) {
    const set = new Set(),
      seen = new Map();
    let fenced = false;
    for (const line of withoutComments(readFileSync(join(root, file), 'utf8')).split(/\r?\n/)) {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      const heading = !fenced && /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
      if (heading) {
        const base = slug(heading[1]),
          count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        set.add(count ? `${base}-${count}` : base);
      }
      for (const [, id] of line.matchAll(/<(?:a|h\d|div|span)[^>]*\s(?:id|name)="([^"]+)"/g)) set.add(id);
    }
    headingCache.set(file, set);
  }
  return headingCache.get(file);
}

/** Links and images of one Markdown text outside code: [{ line, target }]. */
export function linksOf(text) {
  const links = [];
  let fenced = false;
  withoutComments(text)
    .split(/\r?\n/)
    .forEach((raw, index) => {
      if (/^\s*(```|~~~)/.test(raw)) fenced = !fenced;
      if (fenced || /^\s*(```|~~~)/.test(raw)) return;
      const line = raw.replace(/`[^`]*`/g, '');
      for (const [, target] of line.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g))
        links.push({ line: index + 1, target });
      for (const [, target] of line.matchAll(/<(?:img|a)\b[^>]*?\s(?:src|href)="([^"]+)"/g))
        links.push({ line: index + 1, target });
    });
  return links;
}

/** Broken links of the given documents: [{ file, line, target, reason }]. */
export function check(files = documents()) {
  const broken = [];
  for (const file of files) {
    for (const { line, target } of linksOf(readFileSync(join(root, file), 'utf8'))) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
      const [pathPart, hash] = target.split('#'),
        decoded = decodeURI(pathPart);
      let destination = file;
      if (decoded) {
        const absolute = decoded.startsWith('/') ? join(root, decoded) : resolve(root, dirname(file), decoded);
        if (!absolute.startsWith(root) || !existsSync(absolute)) {
          broken.push({ file, line, target, reason: 'no such file' });
          continue;
        }
        destination = relative(root, absolute).replaceAll('\\', '/');
        if (statSync(absolute).isDirectory()) continue;
      }
      if (hash && destination.endsWith('.md') && !anchors(destination).has(decodeURIComponent(hash).toLowerCase()))
        broken.push({ file, line, target, reason: `no heading "#${hash}" in ${destination}` });
    }
  }
  return broken;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = process.argv.length > 2 ? process.argv.slice(2) : documents();
  const broken = check(files);
  for (const { file, line, target, reason } of broken) console.log(`${file}:${line}  ${target}  (${reason})`);
  console.log(`${files.length} documents checked, ${broken.length} broken links`);
  if (broken.length) process.exitCode = 1;
}
