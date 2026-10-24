// WGSL compile guard for the browser checks: every shader module a page creates is compiled for diagnostics, so a WGSL
// error fails the check that drew it even when no pipeline is built from the module or the error surfaces only as a
// later validation message. Install `wgslGuard` as an init script (page.addInitScript or context.addInitScript); it
// reports through the console, which `watchWgsl` collects on the Node side across navigations:
//   [wgsl] module <hash>                      a distinct source compiled (debug level)
//   [wgsl] error <label> <line>:<col> <message> | <source line>
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
    if (!seen.has(key) && !String(descriptor?.label ?? '').startsWith('check-wgsl:')) {
      seen.add(key);
      console.debug(`[wgsl] module ${key}`);
      module.getCompilationInfo().then((info) => {
        const lines = code.split('\n');
        for (const m of info.messages)
          if (m.type === 'error')
            console.error(
              `[wgsl] error ${descriptor.label ?? key} ${m.lineNum}:${m.linePos} ${m.message} | ${(lines[m.lineNum - 1] ?? '').trim().slice(0, 160)}`,
            );
      });
    }
    return module;
  };
  guarded.margoWgslGuard = true;
  GPUDevice.prototype.createShaderModule = guarded;
}

/**
 * Collects a page's `[wgsl]` reports: `modules` (distinct sources compiled) and `errors` (messages). Call before the
 * first navigation.
 */
export function watchWgsl(page) {
  const modules = new Set(),
    errors = [];
  page.on('console', (m) => {
    const text = m.text();
    if (!text.startsWith('[wgsl] ')) return;
    if (text.startsWith('[wgsl] module ')) modules.add(text.slice(14));
    else if (text.startsWith('[wgsl] error ')) errors.push(text.slice(13));
  });
  return { modules, errors };
}
