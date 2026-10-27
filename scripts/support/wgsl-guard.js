// WGSL compile guard for the browser checks: every shader module a page creates is compiled for diagnostics, so a WGSL
// error fails the check that drew it even when no pipeline is built from the module or the error surfaces only as a
// later validation message. Install `wgslGuard` as an init script (page.addInitScript or context.addInitScript); it
// reports through the console, which `watchWgsl` collects on the Node side across navigations:
//   [wgsl] module <hash>                      a distinct source compiled (debug level)
//   [wgsl] error <label> <line>:<col> <message> | <source line>
//   [wgsl] expected <label>                   a module labelled `expect-error:<name>` failed, as its check declared
//   [wgsl] unexpected-success <label>         a module labelled `expect-error:<name>` compiled cleanly (a failure)
// A check that compiles broken WGSL on purpose (to test how the error is reported) names that one module with the
// label `expect-error:<name>`; only its errors are excused, and the run fails if it does not fail.
// scripts/browser.js installs it in every page it opens; scripts/visual-regression.js in every view's context.

/** Init script: wraps GPUDevice.prototype.createShaderModule to check each distinct source's compilation info. */
export function wgslGuard() {
  if (typeof GPUDevice === 'undefined' || GPUDevice.prototype.createShaderModule.margoWgslGuard) return;
  const create = GPUDevice.prototype.createShaderModule,
    seen = new Set(),
    hash = (s) => {
      let h = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
      return (h >>> 0).toString(16).padStart(8, '0') + s.length.toString(16);
    };
  const guarded = function (descriptor) {
    const module = create.call(this, descriptor),
      code = typeof descriptor?.code === 'string' ? descriptor.code : '',
      key = hash(code);
    // scripts/check-wgsl.mjs compiles fragments on purpose and judges them itself.
    const label = String(descriptor?.label ?? '');
    if (!seen.has(key) && !label.startsWith('check-wgsl:')) {
      seen.add(key);
      console.debug(`[wgsl] module ${key}`);
      // Kept until settled, so a harness can wait for every report (scripts/browser.js close()).
      const report = module.getCompilationInfo().then((info) => {
        const lines = code.split('\n'),
          errors = info.messages.filter((m) => m.type === 'error');
        if (label.startsWith('expect-error:')) {
          console.debug(errors.length ? `[wgsl] expected ${label}` : `[wgsl] unexpected-success ${label}`);
          return;
        }
        for (const m of errors)
          console.error(
            `[wgsl] error ${descriptor.label ?? key} ${m.lineNum}:${m.linePos} ${m.message} | ${(lines[m.lineNum - 1] ?? '').trim().slice(0, 160)}`,
          );
      });
      (globalThis.__margoWgslReports ??= []).push(report.catch(() => {}));
    }
    return module;
  };
  guarded.margoWgslGuard = true;
  GPUDevice.prototype.createShaderModule = guarded;
}

/**
 * Collects a page's `[wgsl]` reports: `modules` (distinct sources compiled), `errors` (messages), `expected` (labels of
 * `expect-error:` modules that failed as declared) and `unexpected` (those that compiled cleanly, also a failure). Call
 * before the first navigation.
 */
export function watchWgsl(page) {
  const modules = new Set(),
    errors = [],
    expected = [],
    unexpected = [];
  page.on('console', (m) => {
    const text = m.text();
    if (!text.startsWith('[wgsl] ')) return;
    if (text.startsWith('[wgsl] module ')) modules.add(text.slice(14));
    else if (text.startsWith('[wgsl] error ')) errors.push(text.slice(13));
    else if (text.startsWith('[wgsl] expected ')) expected.push(text.slice(16));
    else if (text.startsWith('[wgsl] unexpected-success ')) unexpected.push(text.slice(26));
  });
  return { modules, errors, expected, unexpected };
}
