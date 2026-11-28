// Start-up hints some built demo pages carry that Vite does not make again on a rebuild:
// - assets/webgl2-preload-<hash>.js, a small classic script that adds <link rel="modulepreload"> for the
//   compatibility layer's chunks when WebGPU is missing or ?backend=webgl2 asks for it;
// - <link rel="modulepreload"> for the chunk the entry imports on start (Vite only preloads static imports).
// A rebuild renames the chunks they point at, so build.mjs rewrites both from the new build with these helpers.
import { createHash } from "node:crypto";

// Older pages name the same script inline-<8 hex>.js.
export const preloadTag =
  /<script src="\.\/assets\/((?:webgl2-preload|inline)-[A-Za-z0-9_-]{8}\.js)"><\/script>/;

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The built chunk in `files` for a chunk name without its hash (`scene` finds `scene-CwdSZCFK.js`), or undefined. */
function chunk(base, files) {
  const pattern = new RegExp(`^${escape(base)}-[A-Za-z0-9_-]{8}\\.js$`);
  const found = files.filter((f) => pattern.test(f));
  if (found.length === 1) return found[0];
  // A chunk of a prebuilt package keeps that package's own hash in its name (`readback-Cf9k53gF-DiYXj9wd.js`), which
  // changes when the package is rebuilt: match on the name before the hashes, when exactly one chunk has it.
  const stem = /^(.+?)(?:-[A-Za-z0-9_]{8})+$/.exec(base)?.[1];
  if (!stem || found.length) return undefined;
  const stemmed = new RegExp(`^${escape(stem)}(?:-[A-Za-z0-9_-]{8}){2,}\\.js$`);
  const same = files.filter((f) => stemmed.test(f));
  return same.length === 1 ? same[0] : undefined;
}

// The two hint forms: the WebGL2 one preloads every chunk in its list (`for(const href of [...])`); the physics one
// preloads one of two wasm loader chunks, picked by whether the browser validates a SIMD module (`[...][simd?0:1]`).
const loopList = /for\(const href of (\[[^\]]*\])\)/;
const pickList = /link\.href=(\[[^\]]*\])\[simd\?0:1\]/;

/** The chunk list in a preload script, and whether it is the one-of-two SIMD pick. */
function listOf(script) {
  const loop = loopList.exec(script);
  if (loop) return { list: loop[1], pick: false };
  const pick = pickList.exec(script);
  if (pick) return { list: pick[1], pick: true };
  throw new Error("webgl2-preload: no chunk list in the script");
}

/** The chunk names a preload script points at with their build hash taken off: `./assets/errors-DkwPZuAq.js` is `errors`. */
export function preloadBases(script) {
  return JSON.parse(listOf(script).list).map(
    (href) => /^\.\/assets\/(.+)-[A-Za-z0-9_-]{8}\.js$/.exec(href)?.[1] ?? href,
  );
}

/**
 * The SIMD pick rewritten 1:1: each entry at its new name, in its place, the rest of the script as it was. Its index
 * picks by position, so no entry may be dropped or added and no import closure is followed.
 */
function rewritePick(script, files) {
  const { list } = listOf(script),
    bases = preloadBases(script),
    found = bases.map((base) => chunk(base, files)),
    missing = bases.findIndex((_, i) => !found[i]);
  if (missing >= 0)
    throw new Error(`webgl2-preload: no single built chunk named ${bases[missing]}`);
  const text = script.replace(
    list,
    JSON.stringify(found.map((file) => `./assets/${file}`)),
  );
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 8);
  return { name: `inline-${hash}.js`, text };
}

/** The chunks a built chunk's `text` imports statically (`import"./x.js"`, `from"./x.js"`); `import("./x.js")` is not. */
export function staticImports(text) {
  return [...text.matchAll(/(?:\bfrom|\bimport)\s*["']\.\/([^"']+\.js)["']/g)].map(
    (m) => m[1],
  );
}

/**
 * The preload script for a new build: the same chunks by name, at their new hashes (`files`, the built assets/
 * names), and its file name from a hash of its text. Without `read` a chunk missing from the build throws, so a page
 * never preloads a file that is not there. With `read` (built file name to its text) the list is the static import
 * closure of the chunks still built under their names: a shared chunk that Rollup names after another of its modules
 * on a rebuild (`version` folded into `errors`) is reached through the chunks that import it. It still throws when
 * none of the names is built.
 */
export function rewritePreload(script, files, read) {
  if (listOf(script).pick) return rewritePick(script, files);
  const bases = preloadBases(script),
    found = bases.map((base) => chunk(base, files)),
    missing = bases.filter((_, i) => !found[i]);
  if (missing.length && (!read || missing.length === bases.length))
    throw new Error(`webgl2-preload: no single built chunk named ${missing[0]}`);
  const list = found.filter(Boolean);
  if (read)
    for (let i = 0; i < list.length; i++)
      for (const next of staticImports(read(list[i])))
        if (files.includes(next) && !list.includes(next)) list.push(next);
  const hrefs = list.map((file) => `./assets/${file}`);
  const text =
    `if(!navigator.gpu||new URLSearchParams(location.search).get("backend")==="webgl2"){for(const href of ${JSON.stringify(hrefs)})` +
    `{const link=document.createElement("link");link.rel="modulepreload";link.crossOrigin="anonymous";link.href=href;document.head.append(link);}}`;
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 8);
  return { name: `webgl2-preload-${hash}.js`, text };
}

/**
 * The `<link rel="modulepreload">` tags the shipped page (`before`) carries ahead of its entry `<script type="module">`
 * that the new build's page (`after`) lacks, for the same chunks at their new names (`files`). Throws when such a
 * chunk is gone from the build. Tags after the entry script are Vite's own preloads of the entry's static imports:
 * Vite writes them again for the new build, under whatever names its chunks now have, so they are not carried.
 */
export function carriedPreloads(before, after, files) {
  const links = [],
    entry = before.search(/<script type="module"/),
    added = entry < 0 ? before : before.slice(0, entry);
  for (const [, href] of added.matchAll(
    /<link rel="modulepreload" crossorigin href="\.\/assets\/([^"]+)">/g,
  )) {
    const base = /^(.+)-[A-Za-z0-9_-]{8}\.js$/.exec(href)?.[1];
    const next = base && chunk(base, files);
    if (!next) throw new Error(`modulepreload: no built chunk for ${href}`);
    if (!after.includes(`href="./assets/${next}"`))
      links.push(
        `<link rel="modulepreload" crossorigin href="./assets/${next}">`,
      );
  }
  return links.join("");
}
