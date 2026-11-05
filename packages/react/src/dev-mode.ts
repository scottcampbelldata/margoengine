declare const process: { env: { NODE_ENV?: string } };

/**
 * True when reading `process.env.NODE_ENV` will not throw: a bundler replaced the expression, or the page has a global
 * `process`. Vite and most bundlers replace the member expression but define no `process`, so `typeof process` says
 * nothing about development; only a page with neither (plain ES modules through an import map) reads false.
 *
 * Guard a hint as `envReadable && process.env.NODE_ENV !== 'production'`, written out at the call site: a production
 * bundle folds that to false and drops the branch, which a boolean exported from here could not do.
 */
export const envReadable: boolean = /* @__PURE__ */ (() => {
  try {
    void process.env.NODE_ENV;
    return true;
  } catch {
    return false;
  }
})();

/** `<DevTools>` opens everywhere but a production build, and a page with no bundler is not one. */
export const panelsByDefault: boolean = !envReadable || process.env.NODE_ENV !== 'production';
