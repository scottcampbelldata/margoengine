// Cloudflare Pages / Netlify `_headers` files: parse the rules and work out a path's headers. Used by
// scripts/csp-check.mjs and the tests that read site/_headers.
/** _headers rules: [pattern RegExp, [[name, value] | ['!', name]]]. `*` is a splat, `:name` one path segment. */
export function parseHeaders(text) {
  const rules = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      rules.push([
        new RegExp(
          '^' +
            line
              .trim()
              .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
              .replace(/\*/g, '.*')
              .replace(/:\w+/g, '[^/]+') +
            '$',
        ),
        [],
      ]);
      continue;
    }
    const entry = line.trim(),
      detach = entry.startsWith('!');
    rules
      .at(-1)[1]
      .push(
        detach
          ? ['!', entry.slice(1).trim()]
          : [entry.slice(0, entry.indexOf(':')).trim(), entry.slice(entry.indexOf(':') + 1).trim()],
      );
  }
  return rules;
}
/** Cloudflare Pages semantics: every matching rule applies in order; repeats join with ", "; `! Name` removes. */
export function headersFor(rules, pathname) {
  const headers = new Map();
  for (const [pattern, entries] of rules)
    if (pattern.test(pathname))
      for (const [name, value] of entries) {
        const key = (name === '!' ? value : name).toLowerCase();
        if (name === '!') headers.delete(key);
        else headers.set(key, headers.has(key) ? `${headers.get(key)}, ${value}` : value);
      }
  return headers;
}
