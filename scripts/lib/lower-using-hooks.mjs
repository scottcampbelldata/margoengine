// Module loader hooks (node:module register) that lower `using` / `await using` declarations to try/finally in the
// repository's own ES modules, for a runtime that cannot parse them (Node 22). scripts/lib/lower-using.mjs registers
// them only there, so Node 24 and later always run the same files natively.
//
// The lowering is Oxc's (vite's transformWithOxc) at target es2024, which rewrites explicit resource management and
// nothing else Node 22 already runs. The helper import it emits resolves to scripts/lib/using-ctx.mjs. Only files
// outside node_modules whose text holds a `using` declaration are touched; every other module loads unchanged.

const HELPER = '@oxc-project/runtime/helpers/usingCtx';
const helperUrl = new URL('./using-ctx.mjs', import.meta.url).href;

/** Text that may hold a `using` or `await using` declaration: the word followed by a name on the same line. */
export const USING = /(?:^|[^\w$.])using[ \t]+[\p{ID_Start}$_]/mu;

let transform;

/** Resolves the helper the lowered code imports to the repository's own clean room helper. */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === HELPER) return { url: helperUrl, format: 'module', shortCircuit: true };
  return nextResolve(specifier, context);
}

/** Lowers `using` declarations in the repository's own ES modules. */
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (result.format !== 'module' || !url.startsWith('file:') || url.includes('/node_modules/')) return result;
  const text = typeof result.source === 'string' ? result.source : Buffer.from(result.source ?? '').toString();
  if (!USING.test(text)) return result;
  transform ??= (await import('vite')).transformWithOxc;
  const lowered = await transform(text, decodeURIComponent(new URL(url).pathname), {
    target: 'es2024',
    lang: 'js',
    sourcemap: true,
  });
  // The test above also matches prose such as "using the"; a file with no declaration loads as it is.
  if (!lowered.code.includes(HELPER)) return result;
  const map = Buffer.from(JSON.stringify(lowered.map)).toString('base64');
  return {
    format: 'module',
    source: `${lowered.code}\n//# sourceMappingURL=data:application/json;base64,${map}\n`,
    shortCircuit: true,
  };
}
