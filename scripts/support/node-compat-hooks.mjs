// The module hooks behind scripts/support/node-compat.mjs, written as plain rules so one file serves both hook APIs:
// module.registerHooks calls resolve and load on the main thread, and module.register (the only one Node 22.12 has)
// loads this file on its hooks thread and passes the rules to initialize. A rule is one of
//   { source: rootURL }                     './name.js' with no file loads './name.ts' when that is inside the root
//   { specifier | pattern, parent?, url }   a specifier (exact, or a regular expression source) loads from url
//   { specifier | pattern, parent?, error } the import fails with that message
//   { lower: true }                         every .ts file is compiled to es2022 JavaScript (rolldown) before it loads
// `parent` is the end of the importing module's URL.
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rules = [];
let transformSync;

/** Adds rules; later calls add to the earlier ones. */
export async function add(more) {
  for (const rule of more) rules.push(rule.source ? { ...rule, root: realpathSync(fileURLToPath(rule.source)) } : rule);
  if (more.some((rule) => rule.lower)) transformSync ??= (await import('rolldown/utils')).transformSync;
}
export const initialize = add;

/** The TypeScript source a relative '.js' specifier stands for, when only the source exists and it is inside `root`. */
export function sourceOf(specifier, parent, root) {
  if (!/^\.{1,2}\//.test(specifier) || !specifier.endsWith('.js') || !parent?.startsWith('file:')) return undefined;
  const ts = new URL(specifier.slice(0, -3) + '.ts', parent);
  if (existsSync(new URL(specifier, parent)) || !existsSync(ts)) return undefined;
  const source = realpathSync(ts),
    within = relative(root, source);
  return within === '..' || within.startsWith('../') || within.startsWith('..\\') || isAbsolute(within)
    ? undefined
    : pathToFileURL(source).href;
}

// Neither hook awaits, so each runs under both APIs: `next` returns a value under registerHooks and a promise under
// module.register.
export function resolve(specifier, context, next) {
  for (const rule of rules) {
    if (rule.source) {
      const url = sourceOf(specifier, context.parentURL, rule.root);
      if (url) return next(url, context);
      continue;
    }
    if (
      rule.specifier === undefined
        ? !rule.pattern || !new RegExp(rule.pattern).test(specifier)
        : rule.specifier !== specifier
    )
      continue;
    if (rule.parent && !context.parentURL?.endsWith(rule.parent)) continue;
    if (rule.error) throw new Error(rule.error);
    return next(rule.url, context);
  }
  return next(specifier, context);
}

export function load(url, context, next) {
  const result = next(url, context);
  if (!transformSync || !url.endsWith('.ts') || !url.startsWith('file:')) return result;
  const lower = (loaded) => ({
    ...loaded,
    format: 'module',
    source: transformSync(
      url,
      typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString(),
      { lang: 'ts', target: 'es2022' },
    ).code,
  });
  return typeof result?.then === 'function' ? result.then(lower) : lower(result);
}
