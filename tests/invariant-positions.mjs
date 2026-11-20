// Finds the vertex position outputs of shadow and depth casters in packages/*/src, for the @invariant checks.
//
// Two programs that draw the same surface into one depth target must write the same depth. WGSL lets each program
// reassociate and fuse float operations (W3C WGSL 15.7.5), so the same light*model*p lands one or a few ulps apart
// unless the position output is declared @invariant (WGSL 12.10); on an Apple M6 (Chromium, Metal) that moved 37% of
// a shadow map's covered texels and shaded a receiver a level apart (docs/known-bugs.md, culling dynamic-check).
//
// A caster shader is found by name: the WGSL string's const or object key, or its vertex output struct, names a
// shadow, caster, occluder, depth or prepass (`shadowShader`, `ShadowOut`, `depthShader`, ...), plus the colour
// modules that a package also draws as its caster (CASTER_MODULES). A full-screen triangle and a fragment input are
// not outputs and are skipped.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('..', import.meta.url));
const packages = join(root, 'packages');

/** Colour modules whose vertex entry is also the package's shadow caster (one module, every pass). */
export const CASTER_MODULES = {
  'packages/terrain/src/shader.ts': 'colour, occluder, cascade and local-shadow passes share this vertex entry',
  'packages/animation/src/vat.ts': 'the VAT colour and shadow pipelines share this vertex entry',
  'packages/culling/src/occluders.ts': 'occluder depth for the occlusion pyramid, drawn by two entries',
  'packages/shader/src/raw.ts': "MargoVelocity is drawn with depthCompare 'equal' against the colour pass",
};

const NAMED = /shadow|caster|occlu|depth|prepass/i;

function* sources(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(ts|js|wgsl)$/.test(name) && !name.endsWith('.d.ts')) yield path;
  }
}

/**
 * Every vertex position output in the source of the named packages (all packages when none are named):
 * `{ file, name, struct, line, invariant }`.
 */
export function positions(names = readdirSync(packages)) {
  const found = [];
  for (const pkg of names) {
    // shared keeps its modules at the package root (no build step); every other package keeps them under src.
    const src = pkg === 'shared' ? join(packages, pkg) : join(packages, pkg, 'src');
    if (!existsSync(src)) continue; // a data or tooling package without src has no shader
    for (const path of sources(src)) {
      const text = readFileSync(path, 'utf8'),
        file = relative(root, path).split('\\').join('/');
      for (const m of text.matchAll(/@builtin\(position\)(\s*@invariant)?/g)) {
        const before = text.slice(0, m.index);
        // A fragment input (`@fragment fn f(@builtin(position) at:vec4f)`) is not an output.
        if (/@fragment\s+fn\s+\w+\s*\([^)]*$/.test(before.slice(-200))) continue;
        // A full-screen triangle (`@vertex fn f(@builtin(vertex_index) i:u32)->@builtin(position)`) draws no geometry.
        const entry = /@vertex\s+fn\s+\w+\s*\(((?:[^()]|\([^()]*\))*)\)\s*->\s*$/.exec(before.slice(-300));
        if (entry && /^\s*@builtin\(vertex_index\)\s*\w+\s*:\s*u32\s*,?\s*$/.test(entry[1])) continue;
        // The shader's name: the last const before it, or the object key of a template (`shadow: /* wgsl */ \`...`).
        const names = [
          ...before.matchAll(/^(?:export\s+)?(?:const|let|function)\s+([A-Za-z_$][\w$]*)/gm),
          ...before.matchAll(/\b([A-Za-z_$][\w$]*):\s*(?:\/\*\s*wgsl\s*\*\/\s*)?`/g),
        ].sort((a, b) => a.index - b.index);
        const name = names.at(-1)?.[1] ?? '';
        const struct = /struct\s+(\w+)\s*\{[^}]*$/.exec(before.slice(-300))?.[1] ?? '';
        found.push({ file, name, struct, line: before.split('\n').length, invariant: !!m[1] });
      }
    }
  }
  return found;
}

/** Whether a position from positions() belongs to a shadow or depth caster. */
export const isCaster = (p) =>
  p.file in CASTER_MODULES ? p.struct !== 'Fullscreen' : NAMED.test(p.name) || NAMED.test(p.struct);

/** The caster positions of one package, as `file:line (struct or name)` for those without @invariant. */
export function casters(pkg) {
  const all = positions([pkg]).filter(isCaster);
  return {
    all,
    missing: all.filter((p) => !p.invariant).map((p) => `${p.file}:${p.line} (${p.struct || p.name})`),
  };
}
