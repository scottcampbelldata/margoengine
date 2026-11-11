// WGSL return-path gate (KB-FF1b, run by `npm run hygiene`): every value-returning WGSL function the packages ship
// must end in a return on every path, the rule Firefox's WGSL front end enforces beyond the spec's behavior analysis
// (scripts/support/wgsl-guard.js `wgslReturnGaps`). coastal.ts `root` ended in a `loop` left only by `return`; Chromium
// and the WebGL2 layer accepted it and the biomes suite failed only in Firefox (KB-FF1).
// Three layers check the same rule:
//   - here, on the source text: every `.wgsl` file under packages/, and every WGSL function written out whole in
//     packages/*/src and packages/shared (`fn name(...) -> T { ... }` cut at its matching brace). A function built
//     from `${...}` pieces or JavaScript string pieces is not complete in the source, so it is left to the next two;
//   - scripts/check-wgsl.mjs (check:merge) on every module the packages' shader builders return, with their flags
//     both ways;
//   - scripts/support/wgsl-guard.js on every module any browser check creates, so assembled shaders are checked as
//     the GPU receives them.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { wgslReturnGaps } from './wgsl-guard.js';

/** The WGSL functions written out whole in a source file's text: [{ name, source, line }]. */
export function writtenFunctions(text) {
  const found = [];
  for (const match of text.matchAll(/\bfn\s+(\w+)\s*\(/g)) {
    let i = match.index + match[0].length,
      depth = 1;
    for (; i < text.length && depth; i++) depth += text[i] === '(' ? 1 : text[i] === ')' ? -1 : 0;
    if (!/^\s*->\s*[^{;]+?\s*\{/.test(text.slice(i, i + 160))) continue;
    let j = text.indexOf('{', i) + 1;
    depth = 1;
    for (; j < text.length && depth; j++) depth += text[j] === '{' ? 1 : text[j] === '}' ? -1 : 0;
    const source = text.slice(match.index, j);
    if (/\$\{|['"`]/.test(source)) continue;
    found.push({ name: match[1], source, line: text.slice(0, match.index).split('\n').length });
  }
  return found;
}

/** Every return-path gap in the repository's shipped WGSL: ['path:line name', ...], and how many functions were read. */
export function findWgslReturnGaps(root) {
  const gaps = [];
  let checked = 0;
  const walk = (dir, shipped) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, shipped);
      else if (name.endsWith('.wgsl')) {
        const text = readFileSync(path, 'utf8');
        checked += (text.match(/\bfn\s+\w+\s*\(/g) ?? []).length;
        for (const gap of wgslReturnGaps(text))
          gaps.push(`${relative(root, path).replaceAll('\\', '/')}:${gap.line} ${gap.name}`);
      } else if (shipped && /\.(ts|js|mjs)$/.test(name) && !name.endsWith('.d.ts')) {
        for (const fn of writtenFunctions(readFileSync(path, 'utf8'))) {
          checked++;
          if (wgslReturnGaps(fn.source).length)
            gaps.push(`${relative(root, path).replaceAll('\\', '/')}:${fn.line} ${fn.name}`);
        }
      }
    }
  };
  const packages = join(root, 'packages');
  for (const pkg of readdirSync(packages)) {
    const dir = join(packages, pkg);
    if (!statSync(dir).isDirectory()) continue;
    if (pkg === 'shared') {
      walk(dir, true);
      continue;
    }
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist') continue;
      const path = join(dir, name),
        shipped = name === 'src';
      if (statSync(path).isDirectory()) walk(path, shipped);
    }
  }
  return { gaps: [...new Set(gaps)], checked };
}

/** Throws when any shipped WGSL function returns a value without ending in a return on every path. */
export function assertWgslReturns(root) {
  const { gaps } = findWgslReturnGaps(root);
  if (gaps.length)
    throw new Error(
      `WGSL functions that return a value but do not end in a return on every path (Firefox rejects them; end the function in a return after its loop, or give the if an else; KB-FF1b):\n  ${gaps.join('\n  ')}`,
    );
}
