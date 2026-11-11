// Browser console lines a check may accept, pinned to the exact line and the browser versions it was seen in: a browser
// defect with an upstream report, or an advisory about behaviour that WebGPU itself leaves to the implementation. Every
// other warning or error still fails a check. A new browser version fails again until someone confirms the line there
// and widens the range.

/**
 * Firefox's advisory for every texSubImage from a pixel unpack buffer, exact full-row uploads at unpack alignment 1, 4
 * and 8 included, while the pixels land exact (KBL3c, docs/upstream-reports/KBL3c/report.md;
 * packages/webgl2-compat/test/pbo-upload-browser.mjs proves the pixels).
 */
export const FIREFOX_FINAL_ROW_LINE =
  '[JavaScript Warning: "WebGL warning: texSubImage: Uploads from a buffer with a final row with a byte count smaller than the row stride can incur extra overhead."]';

/** The Firefox major versions the final-row line was seen in (157, 2026-11-11). */
export const FIREFOX_FINAL_ROW_VERSIONS = Object.freeze({ first: 157, last: 157 });

/**
 * Firefox's advisory, once per context, for a draw that samples a depth texture through a comparison sampler with
 * linear filtering. WebGPU defines such a sampler and leaves its filtering to the implementation, as WebGL does (W3C
 * WebGPU, GPUSamplerDescriptor `compare`: "Comparison samplers may use filtering, but the sampling results will be
 * implementation-dependent"); the WebGL2 layer maps it to GL's LINEAR comparison, the hardware's percentage-closer
 * filter that native WebGPU uses on the same GPU. Shadow maps sample this way (packages/shadows). One line per draw
 * entry point, as Firefox names the call that first meets it.
 */
export const FIREFOX_DEPTH_COMPARE_LINES = Object.freeze(
  ['drawArrays', 'drawArraysInstanced', 'drawElements', 'drawElementsInstanced', 'drawRangeElements'].map(
    (call) =>
      `[JavaScript Warning: "WebGL warning: ${call}: Depth texture comparison requests (e.g. \`LINEAR\`) Filtering, but behavior is implementation-defined, and so on some systems will sometimes behave as \`NEAREST\`. (warns once)"]`,
  ),
);

/** The Firefox major versions the depth-comparison line was seen in (157, 2026-11-11). */
export const FIREFOX_DEPTH_COMPARE_VERSIONS = Object.freeze({ first: 157, last: 157 });

/**
 * Whether `text`, a console line of the page `hardware` describes (`openBrowser`'s `hardware`: `browserName` and
 * `browserVersion`), is an accepted browser advisory: {@link FIREFOX_FINAL_ROW_LINE} or one of
 * {@link FIREFOX_DEPTH_COMPARE_LINES}, exactly, on Firefox within the versions each was seen in.
 */
export function acceptedAdvisory(text, hardware) {
  if (hardware?.browserName !== 'firefox') return false;
  const versions =
    text === FIREFOX_FINAL_ROW_LINE
      ? FIREFOX_FINAL_ROW_VERSIONS
      : FIREFOX_DEPTH_COMPARE_LINES.includes(text)
        ? FIREFOX_DEPTH_COMPARE_VERSIONS
        : null;
  if (!versions) return false;
  const major = Number(/^(\d+)(?:\.|$)/.exec(String(hardware.browserVersion))?.[1]);
  return major >= versions.first && major <= versions.last;
}

/**
 * Whether `text` is Firefox's report of a WebGL context the page lost on purpose (`WEBGL_lose_context.loseContext()`:
 * the WebGL2 layer's probe and `device.destroy()` do it, as do test pages). Chromium prints nothing for it. A check
 * counts these lines and asserts the number its page loses, so an unplanned loss still fails.
 */
export function firefoxContextLost(text, hardware) {
  return (
    hardware?.browserName === 'firefox' &&
    /^\[JavaScript Warning: "WebGL context was lost\." \{file: "[^"]+" line: \d+\}\]$/.test(text)
  );
}

/**
 * Console bookkeeping for a check that fails on any warning: `problems` gets every error and warning except
 * {@link acceptedAdvisory} lines and the deliberate context losses, which `lost` counts (Firefox only).
 */
export function watchConsole(page, hardware) {
  const watch = { problems: [], lost: 0 };
  page.on('pageerror', (error) => watch.problems.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    const text = message.text();
    if (firefoxContextLost(text, hardware)) watch.lost++;
    else if (!acceptedAdvisory(text, hardware)) watch.problems.push(text);
  });
  return watch;
}

/**
 * The deliberate losses a page on the WebGL2 layer reports in Firefox: the layer's one capability probe (`probeWebGL2`),
 * and nothing in other browsers or on native WebGPU.
 */
export function expectedContextLosses(hardware) {
  return hardware?.browserName === 'firefox' && hardware?.webgpu?.vendor === 'margo-webgl2' ? 1 : 0;
}
