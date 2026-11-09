// The error convention (docs/conventions.md) for code in packages/shared, which is bundled into packages that may not depend
// on @margoengine/math (importing it here would make every such package build after math without declaring it).
// The result has MargoError's name and `code`, so `error instanceof MargoError` (it matches by name) and
// `error.code` behave exactly as for the class.
export const margoError = (code, message) => Object.assign(new Error(message), { name: 'MargoError', code });

// Core and the stage keep their messages short and link each one to its entry on the error help page
// (site/errors.html, generated from scripts/errors/entries.js; tests/errors-page.test.js keeps them in step).
const linked = (message, anchor) => `${message}; see https://margoengine.com/errors#${anchor}`;
/** `margoError` whose message links to `anchor` (default the code) on the error help page. */
export const fault = (code, message, anchor = code) => margoError(code, linked(message, anchor));
/** TypeError whose message links to `anchor` on the error help page. */
export const typeError = (message, anchor) => new TypeError(linked(message, anchor));
/** RangeError whose message links to `anchor` on the error help page. */
export const rangeError = (message, anchor) => new RangeError(linked(message, anchor));

/** Reject replacement of a retained transform vector, including from non-module callers. */
export const vectorAssignment = () => {
  throw Object.assign(typeError('Retained vector: use a transform setter', 'transform'), { code: 'transform' });
};

/** Translate only policy-blocked Wasm initialization, including Emscripten's wrapped abort. Keep other failures intact. */
export function wasmError(error) {
  if (
    !/^(Compile|Eval|Runtime)Error$/.test(error?.name) ||
    !/wasm-unsafe-eval|content security policy|\bCSP\b|disallowed by embedder/i.test(error.message)
  )
    return error;
  return Object.assign(
    margoError(
      'failed',
      "Wasm compilation blocked by CSP; add 'wasm-unsafe-eval' to script-src; see https://margoengine.com/llms/docs/csp.md",
    ),
    { cause: error },
  );
}
