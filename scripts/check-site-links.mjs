// Checks that every margoengine.com link in the tracked sources names a page the site build produces, and an anchor that
// page has. Coded errors, READMEs and the site point developers at these links, so a dead one leaves a reader with
// nothing. Part of `npm run hygiene`, and tests/site-links.test.js runs it.
//   node scripts/check-site-links.mjs     print each dead link and exit 1 if there is one
// The rule: a link in code or docs names a route the site serves (site/, the /catalog/ copy of docs/, the /llms/ pages
// of scripts/build-llms.mjs, and the demos, gallery, voxel and bench pages listed in scripts/support/site-routes.mjs).
// Package help lives at /llms/packages/<package>.md and /llms/docs/<doc>.md; error help at /errors#<id>.
// A site/_redirects rule keeps its old address live, so its destination page and anchor are checked as well.
// A page under site/ also has its relative links (`href` and `src` that name no scheme) resolved against its own route with
// the same route list, so a renamed page or asset leaves no dead link on the pages that point at it.
// Skipped: tests, the generated site/llms-full.txt, templates (`${...}`, `<id>`), XML namespace names and the private notes folder.
// Nothing is fetched.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sitePages } from './build-llms.mjs';
import { slug } from './docs-links.mjs';
import { collectCorpus } from './support/llms-corpus.mjs';
import { redirectRules, resolveRoute, siteFiles } from './support/site-routes.mjs';

const TEXT = /\.(?:[cm]?[jt]sx?|md|html|json|rs|txt|css|toml|yml|yaml)$/;
const SKIP_FILE =
  /(?:^|\/)(?:private|node_modules|dist|tests?)\/|\.test\.[cm]?[jt]s$|(?:^|\/)package-lock\.json$|^site\/llms-full\.txt$/;
// An href or src attribute of an HTML page.
const ATTRIBUTE = /\s(?:href|src|poster)="([^"]*)"/g;
const LINK = /https?:\/\/(?:www\.)?margoengine\.com(\/[^\s)"'`<>\\,;]*)?/g;

/** Ids an HTML text defines (`id="..."` and `name="..."`). */
const htmlIds = (text) => new Set([...text.matchAll(/\s(?:id|name)="([^"]+)"/g)].map((m) => m[1]));

/** Heading anchors of a Markdown text, as GitHub names them (repeats get -1, -2). */
function markdownIds(text) {
  const ids = new Set(),
    seen = new Map();
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = !fenced && /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const base = slug(heading[1]),
      count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    ids.add(count ? `${base}-${count}` : base);
  }
  return ids;
}

/**
 * The route a relative `target` of the page at `page` (a path under site/) names, and its fragment; null for what is not
 * a relative link: another scheme (https:, mailto:, data:), a protocol-relative link, a same-page fragment or a
 * template. A root path (`/x`) is resolved from the site root.
 */
function relativeRoute(page, target) {
  if (!target || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target) || /[$*{}<]/.test(target)) return null;
  const hashAt = target.indexOf('#'),
    fragment = hashAt < 0 ? null : target.slice(hashAt + 1),
    path = (hashAt < 0 ? target : target.slice(0, hashAt)).split('?')[0];
  if (!path) return null;
  const joined = path.startsWith('/') ? path.slice(1) : posix.join(posix.dirname(page), path),
    route = posix.normalize(joined);
  // A path that climbs above the site root names nothing the site serves.
  return { route: `/${route.replace(/^\.\/?$/, '')}`, fragment: fragment || null };
}

/** Tracked files that can hold a link, as repository paths. */
function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\0')
    .filter((file) => file && TEXT.test(file) && !SKIP_FILE.test(file));
}

/**
 * The dead links under `root`: [{ file, line, url, why }]. `files` (repository paths, default the tracked ones) and
 * `pages` (the /llms/ pages, default the real ones) are for tests.
 */
export function siteLinkFindings(root, { files = trackedFiles(root), pages = sitePages(collectCorpus(root)) } = {}) {
  const { served, source } = siteFiles(root);
  for (const path of pages.keys()) served.add(path);
  const redirects = redirectRules(root);
  for (const { from } of redirects) served.add(from.replace(/^\//, ''));
  const idCache = new Map();
  const idsOf = (route) => {
    if (!idCache.has(route)) {
      let ids = null;
      if (pages.has(route)) ids = markdownIds(pages.get(route));
      else if (source.has(route) && route.endsWith('.html')) {
        try {
          ids = htmlIds(readFileSync(join(root, source.get(route)), 'utf8'));
          // The catalog page builds one card per docs/catalog.json entry in the browser, each with its id as anchor.
          if (route === 'catalog/index.html')
            for (const entry of JSON.parse(readFileSync(join(root, 'docs/catalog.json'), 'utf8'))) ids.add(entry.id);
        } catch {
          ids = null;
        }
      }
      idCache.set(route, ids);
    }
    return idCache.get(route);
  };
  const findings = [];
  // A redirect makes its old address count as live, so the address it sends the reader to has to be live too.
  for (const { line, to = '' } of redirects) {
    if (!to.startsWith('/') || /[:*]/.test(to)) continue;
    const [path, fragment] = to.split('#'),
      found = resolveRoute(served, path.split('?')[0]),
      ids = found && fragment ? idsOf(found) : null,
      why = !found ? `no page at ${path}` : ids && !ids.has(fragment) ? `${found} has no #${fragment}` : null;
    if (why) findings.push({ file: 'site/_redirects', line, url: to, why });
  }
  for (const file of files) {
    let text;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      continue;
    }
    const page = /^site\/.*\.html$/.test(file) ? file.slice('site/'.length) : null;
    text.split(/\r?\n/).forEach((line, index) => {
      if (page)
        for (const [, target] of line.matchAll(ATTRIBUTE)) {
          const link = relativeRoute(page, target);
          if (!link) continue;
          const found = resolveRoute(served, link.route);
          if (!found) {
            findings.push({ file, line: index + 1, url: target, why: `no page at ${link.route}` });
            continue;
          }
          if (link.fragment) {
            const ids = idsOf(found);
            if (ids && !ids.has(link.fragment))
              findings.push({ file, line: index + 1, url: target, why: `${found} has no #${link.fragment}` });
          }
        }
      for (const match of line.matchAll(LINK)) {
        let [url, path = '/'] = match;
        const after = line.slice(match.index + url.length);
        // A template (`${...}` after the link, `<id>` or a placeholder) is not a link.
        if (/^(?:\$\{|<|\{|\*)/.test(after) || /[$*{]/.test(path)) continue;
        // An XML namespace name is an identifier, not a page.
        if (/xmlns(?::\w+)?=["']$/.test(line.slice(0, match.index))) continue;
        url = url.replace(/[.:!?]+$/, '');
        path = path.replace(/[.:!?]+$/, '');
        const hashAt = path.indexOf('#');
        let fragment = hashAt < 0 ? null : path.slice(hashAt + 1);
        let route = (hashAt < 0 ? path : path.slice(0, hashAt)).split('?')[0] || '/';
        if (fragment === '') continue;
        const found = resolveRoute(served, route);
        if (!found) {
          findings.push({ file, line: index + 1, url, why: `no page at ${route}` });
          continue;
        }
        if (fragment !== null) {
          const ids = idsOf(found);
          if (ids && !ids.has(fragment))
            findings.push({ file, line: index + 1, url, why: `${found} has no #${fragment}` });
        }
      }
    });
  }
  return findings;
}

/** Throws when a link is dead; the message lists each one. `npm run hygiene` calls it. */
export function assertSiteLinksLive(root = resolve(import.meta.dirname, '..')) {
  const findings = siteLinkFindings(root);
  if (findings.length)
    throw new Error(
      `${findings.length} margoengine.com link(s) name no page or anchor the site build produces ` +
        `(rule: scripts/check-site-links.mjs):\n  ${findings.map((f) => `${f.file}:${f.line} ${f.url} (${f.why})`).join('\n  ')}`,
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const findings = siteLinkFindings(resolve(import.meta.dirname, '..'));
  for (const f of findings) console.error(`${f.file}:${f.line} ${f.url} (${f.why})`);
  if (findings.length) {
    console.error(`${findings.length} dead margoengine.com link(s)`);
    process.exitCode = 1;
  } else console.log('every margoengine.com link names a page the site build produces');
}
