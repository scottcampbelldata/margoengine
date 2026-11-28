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

// The living museum's shipped page also held Vite's own preload of a shared chunk the entry imports statically
// (version-YYhCZP03.js, after the entry script). A rebuild names that shared chunk differently, and the build stopped
// with "no built chunk" after it had already removed the shipped chunks. Vite writes those preloads again itself.
test("Vite's own preloads after the entry script are not carried, only those placed ahead of it", () => {
  const before =
    '<head><link rel="modulepreload" crossorigin href="./assets/scene-BvrlAlsQ.js"><script src="./assets/inline-feb9a6c7.js"></script>' +
    '  <script type="module" crossorigin src="./assets/index-BLGaq8GJ.js"></script>' +
    '  <link rel="modulepreload" crossorigin href="./assets/version-YYhCZP03.js">';
  const files = ["index-BXZDA2hV.js", "scene-BEokXwn8.js", "errors-AAAAbbbb.js"];
  assert.equal(
    carriedPreloads(before, "<head>", files),
    '<link rel="modulepreload" crossorigin href="./assets/scene-BEokXwn8.js">',
  );
  assert.throws(
    () => carriedPreloads(before, "<head>", ["index-BXZDA2hV.js"]),
    /no built chunk for scene-BvrlAlsQ\.js/,
  );
});

// The same page names its WebGL2 preload script inline-feb9a6c7.js, which preloadTag did not match: the build deleted
// it as a hashed chunk and left the page loading a missing script. Its list also named version-YYhCZP03.js, a shared
// chunk the rebuild folds into another one, so a rewrite by names alone could not succeed.
test("an inline- preload script is rewritten from the static imports of the chunks still built by name", () => {
  assert.equal(
    preloadTag.exec('<head><script src="./assets/inline-feb9a6c7.js"></script>')?.[1],
    "inline-feb9a6c7.js",
  );
  const old =
    'if(!navigator.gpu||new URLSearchParams(location.search).get("backend")==="webgl2"){for(const href of ["./assets/compat-CDoDsXE8-CDoDsXE8.js","./assets/index-BLGaq8GJ.js","./assets/version-YYhCZP03.js"]){const link=document.createElement("link");link.rel="modulepreload";link.crossOrigin="anonymous";link.href=href;document.head.append(link);}}';
  const texts = {
    "compat-CDoDsXE8-AAAAaaaa.js": 'import{a as e}from"./errors-BBBBbbbb.js";import"./device-CCCCcccc.js";const t=()=>import("./later-DDDDdddd.js");',
    "index-EEEEeeee.js": 'import{b}from"./errors-BBBBbbbb.js";',
    "errors-BBBBbbbb.js": "export const a=1,b=2;",
    "device-CCCCcccc.js": "export{};",
    "later-DDDDdddd.js": "export{};",
  };
  const files = Object.keys(texts);
  const next = rewritePreload(old, files, (f) => texts[f]);
  assert.deepEqual(preloadBases(next.text), ["compat-CDoDsXE8", "index", "errors", "device"]);
  assert.throws(() => rewritePreload(old, files), /no single built chunk named version/);
  assert.throws(
    () => rewritePreload(old, ["later-DDDDdddd.js"], (f) => texts[f]),
    /no single built chunk named compat-CDoDsXE8/,
  );
});

// The rewrite above dropped readback-Cf9k53gF-DiYXj9wd.js: its inner hash belongs to the prebuilt package and changed
// with it, so the name with that hash matched nothing although readback-BaGYuNDt-yw5WeuF6.js was built.
test("a package chunk whose inner hash changed is found by the name before its hashes", () => {
  const old =
    'if(!navigator.gpu||new URLSearchParams(location.search).get("backend")==="webgl2"){for(const href of ["./assets/readback-Cf9k53gF-DiYXj9wd.js","./assets/dist-DOctyKH7.js"]){const link=document.createElement("link");link.rel="modulepreload";link.crossOrigin="anonymous";link.href=href;document.head.append(link);}}';
  const files = ["readback-BaGYuNDt-yw5WeuF6.js", "dist-AAAAaaaa.js", "dist-BBBBbbbb.js"];
  assert.deepEqual(preloadBases(rewritePreload(old, files, () => "").text), ["readback-BaGYuNDt"]);
  assert.throws(() => rewritePreload(old, files), /no single built chunk named dist/);
});
