// Module-scope WGSL names declared more than once. WGSL gives functions, structs, aliases, consts, overrides and
// module-scope vars one namespace, so a program joined from chunks that each declare `rippleAt` fails to compile
// ("redeclaration of 'rippleAt'", KB-WATER-RIPPLEDUP1). The shared test harnesses (postfx-gpu.js, gpu-recorder.js,
// fake-webgpu.mjs, core-draw-gpu.js) run every createShaderModule source through assertWgslDeclaredOnce, so a CPU test
// that builds a composed program finds the clash before a GPU does.
// ponytail: a text scan, not a parser: comments are dropped and brace bodies skipped, which is enough for module scope.

const DECLARATION = /\b(?:fn|struct|alias|const|override)\s+([A-Za-z_]\w*)|\bvar\b\s*(?:<[^>]*>)?\s*([A-Za-z_]\w*)/g;

/** The module-scope names `code` declares more than once, each listed once, in source order. */
export function wgslRedeclarations(code) {
  const text = code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  let top = '',
    depth = 0;
  for (const ch of text) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--, (top += ' ');
    else if (depth === 0) top += ch;
  }
  const seen = new Set(),
    twice = new Set();
  for (const m of top.matchAll(DECLARATION)) {
    const name = m[1] ?? m[2];
    (seen.has(name) ? twice : seen).add(name);
  }
  return [...twice];
}

/** Throws, naming each name, when a shader module source declares a module-scope name twice. */
export function assertWgslDeclaredOnce(code, label = 'shader module') {
  if (typeof code !== 'string') return;
  const twice = wgslRedeclarations(code);
  if (twice.length)
    throw new Error(
      `wgsl-redeclared: ${label} declares ${twice.map((n) => `'${n}'`).join(', ')} more than once at module scope; ` +
        'a real GPU rejects it ("redeclaration of"). Rename the clashing chunk declaration.',
    );
}
