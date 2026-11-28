// Start-up hints some built demo pages carry that Vite does not make again on a rebuild:
// - assets/webgl2-preload-<hash>.js, a small classic script that adds <link rel="modulepreload"> for the
//   compatibility layer's chunks when WebGPU is missing or ?backend=webgl2 asks for it;
// - <link rel="modulepreload"> for the chunk the entry imports on start (Vite only preloads static imports).
// A rebuild renames the chunks they point at, so build.mjs rewrites both from the new build with these helpers.
import { createHash } from "node:crypto";

export const preloadTag =
  /<script src="\.\/assets\/(webgl2-preload-[A-Za-z0-9_-]{8}\.js)"><\/script>/;

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The built chunk in `files` for a chunk name without its hash (`scene` finds `scene-CwdSZCFK.js`), or undefined. */
function chunk(base, files) {
  const pattern = new RegExp(`^${escape(base)}-[A-Za-z0-9_-]{8}\\.js$`);
  const found = files.filter((f) => pattern.test(f));
  return found.length === 1 ? found[0] : undefined;
}

/** The chunk names a preload script points at with their build hash taken off: `./assets/errors-DkwPZuAq.js` is `errors`. */
export function preloadBases(script) {
  const list = /for\(const href of (\[[^\]]*\])\)/.exec(script);
  if (!list) throw new Error("webgl2-preload: no chunk list in the script");
  return JSON.parse(list[1]).map(
    (href) => /^\.\/assets\/(.+)-[A-Za-z0-9_-]{8}\.js$/.exec(href)?.[1] ?? href,
  );
}

/**
 * The preload script for a new build: the same chunks by name, at their new hashes (`files`, the built assets/
 * names), and its file name from a hash of its text. Throws when a chunk is missing from the build, so a page never
 * preloads a file that is not there.
 */
export function rewritePreload(script, files) {
  const hrefs = preloadBases(script).map((base) => {
    const found = chunk(base, files);
    if (!found)
      throw new Error(`webgl2-preload: no single built chunk named ${base}`);
    return `./assets/${found}`;
  });
  const text =
    `if(!navigator.gpu||new URLSearchParams(location.search).get("backend")==="webgl2"){for(const href of ${JSON.stringify(hrefs)})` +
    `{const link=document.createElement("link");link.rel="modulepreload";link.crossOrigin="anonymous";link.href=href;document.head.append(link);}}`;
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 8);
  return { name: `webgl2-preload-${hash}.js`, text };
}

/**
 * The `<link rel="modulepreload">` tags of the shipped page (`before`) that the new build's page (`after`) lacks, for
 * the same chunks at their new names (`files`). Throws when a preloaded chunk is gone from the build.
 */
export function carriedPreloads(before, after, files) {
  const links = [];
  for (const [, href] of before.matchAll(
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
