// Browser console lines a check may accept, each one a browser defect with an upstream report, pinned to the exact
// line and the browser versions it was seen in. Every other warning or error still fails a check. A new browser version
// fails again until someone confirms the line there and widens the range.

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
 * Whether `text`, a console line of the page `hardware` describes (`openBrowser`'s `hardware`: `browserName` and
 * `browserVersion`), is an accepted browser advisory: only {@link FIREFOX_FINAL_ROW_LINE}, exactly, on Firefox within
 * {@link FIREFOX_FINAL_ROW_VERSIONS}.
 */
export function acceptedAdvisory(text, hardware) {
  if (hardware?.browserName !== 'firefox' || text !== FIREFOX_FINAL_ROW_LINE) return false;
  const major = Number(/^(\d+)(?:\.|$)/.exec(String(hardware.browserVersion))?.[1]);
  return major >= FIREFOX_FINAL_ROW_VERSIONS.first && major <= FIREFOX_FINAL_ROW_VERSIONS.last;
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
