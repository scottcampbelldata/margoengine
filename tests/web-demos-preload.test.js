// A rebuilt demo page kept its <script src="./assets/webgl2-preload-<hash>.js"> while build.mjs deleted the file as a
// hashed chunk, so the page loaded a missing script. The build now rewrites the preload for the new chunk names.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  carriedPreloads,
  preloadBases,
  preloadTag,
  rewritePreload,
} from "../scripts/web-demos/preload.mjs";

const shipped =
  'if(!navigator.gpu||new URLSearchParams(location.search).get("backend")==="webgl2"){for(const href of ["./assets/compatibility-WZ6tR0Al.js","./assets/errors-DkwPZuAq.js"]){const link=document.createElement("link");link.rel="modulepreload";link.crossOrigin="anonymous";link.href=href;document.head.append(link);}}';

test("the preload is rewritten for the rebuilt chunk names and named by its own hash", () => {
  assert.deepEqual(preloadBases(shipped), ["compatibility", "errors"]);
  const files = [
    "index-D_0JqhKJ.js",
    "compatibility-AAAAbbbb.js",
    "errors-CCCCdddd.js",
    "errors-ui-EEEEffff.js",
  ];
  const next = rewritePreload(shipped, files);
  assert.match(next.name, /^webgl2-preload-[0-9a-f]{8}\.js$/);
  assert.equal(
    next.text,
    shipped
      .replace("compatibility-WZ6tR0Al", "compatibility-AAAAbbbb")
      .replace("errors-DkwPZuAq", "errors-CCCCdddd"),
  );
  assert.equal(
    rewritePreload(shipped, ["compatibility-WZ6tR0Al.js", "errors-DkwPZuAq.js"])
      .text,
    shipped,
  );
  assert.match(
    `<head><script src="./assets/${next.name}"></script>`,
    preloadTag,
  );
});

test("a chunk the build no longer makes is an error, not a preload of a missing file", () => {
  assert.throws(
    () => rewritePreload(shipped, ["compatibility-AAAAbbbb.js"]),
    /no single built chunk named errors/,
  );
});

test("the shipped page's preload of its start-up chunk carries over to the new chunk name", () => {
  const before =
    '<head><link rel="modulepreload" crossorigin href="./assets/scene-DFR2PeTS.js"><script src="./assets/webgl2-preload-f92767f0.js"></script>';
  const files = ["index-D_0JqhKJ.js", "scene-CwdSZCFK.js"];
  assert.equal(
    carriedPreloads(before, "<head>", files),
    '<link rel="modulepreload" crossorigin href="./assets/scene-CwdSZCFK.js">',
  );
  assert.equal(
    carriedPreloads(
      before,
      '<link rel="modulepreload" crossorigin href="./assets/scene-CwdSZCFK.js">',
      files,
    ),
    "",
  );
  assert.throws(
    () => carriedPreloads(before, "<head>", ["index-D_0JqhKJ.js"]),
    /no built chunk for scene-DFR2PeTS\.js/,
  );
});
