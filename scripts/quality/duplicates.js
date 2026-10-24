// Gate 2, duplicates: code copied between packages. Our own detector, no dependency:
// - every packages/*/src file (.ts, .js, .mjs, .wgsl) becomes a list of normalised lines: comments dropped, whitespace
//   collapsed, lines that carry no code of their own (closing brackets, imports, re-export lists) skipped;
// - each run of WINDOW consecutive normalised lines with at least MIN_CHARS characters is hashed;
// - a hash found in two or more packages is a duplicate; the lines its windows cover are counted per package pair.
// Items: `<a> | <b>` -> duplicated lines (both sides). Also `reexport <file> <name> from <specifier>` -> 1 for each
// runtime value an entry re-exports from another package (the same API under two names; types are free).
// packages/shared is the sanctioned shared source (outside any src/), so it is not scanned.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync } from 'rolldown/utils';

export const WINDOW = 6;
export const MIN_CHARS = 200;

/** Signatures of algorithms known to be copied (HANDOFF dedupe list); packages/shared holds the sanctioned copies. */
export const FAMILIES = {
  'crc32-table': /0xedb88320/i, // CRC-32 (IEEE) table polynomial: shared/crc32.js
  'inflate-tables': /3,\s*4,\s*5,\s*6,\s*7,\s*8,\s*9,\s*10,\s*11,\s*13,\s*15,\s*17/, // DEFLATE length bases: shared/inflate.js
  'glb-container': /0x46546c67/i, // 'glTF' GLB magic: GLB read/write
  'gltf-accessor': /\bcomponentType\b/, // glTF accessor readers
  'hidden-ancestor': /for \(\s*(?:let )?[^;{]*;[^;{]*;[^{]*?parents(?:\?\.)?\[[\s\S]{0,240}?\.hidden\[/, // visibility walk up store.parents: shared/visibility.js
  'ggx-ndf': /\(\s*[\w.]*\s*-\s*1(?:\.0?)?\s*\)\s*\+\s*1(?:\.0?)?\b/, // GGX D term denominator nh*nh*(a2 - 1) + 1
  'hex-colour': /\/\^#\??\(?\[0-9a-f/i, // '#rgb' / '#rrggbb' parsing regex: math/color
  'partial-view': /\[0\] !== 0 \|\| [\w.]+\[1\] !== 0 \|\| [\w.]+\[2\] !== [\w.]*width/, // full-view test of a view rectangle: core renderer
};

const SOURCE = /^packages\/([^/]+)\/src\/.*\.(ts|js|mjs|wgsl)$/;
const SKIP = /\/(vendor|generated)\//;

/** Normalised code lines of a file: [{ text, line }] with 1-based original line numbers. */
export function normalise(text) {
  const out = [];
  let block = false;
  text.split(/\r?\n/).forEach((raw, i) => {
    let s = raw;
    if (block) {
      const end = s.indexOf('*/');
      if (end < 0) return;
      s = s.slice(end + 2);
      block = false;
    }
    s = s.replace(/\/\*.*?\*\//g, ' ');
    const open = s.indexOf('/*');
    if (open >= 0 && !/['"`]/.test(s.slice(0, open))) {
      s = s.slice(0, open);
      block = true;
    }
    s = s
      .replace(/(^|[^:'"`\\])\/\/.*$/, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    // Also skipped: the [Symbol.dispose] boilerplate docs/conventions.md asks every disposable class to repeat.
    if (s.length < 3 || /^[\])};,\s]*$/.test(s) || /^(import\b|export (type )?\{|export \*)/.test(s)) return;
    if (/Symbol\.dispose|^this\.dispose\(\);$/.test(s)) return;
    out.push({ text: s, line: i + 1 });
  });
  return out;
}

// 2 x 32-bit FNV-1a over a string, as a key.
function hash(s) {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) + i;
  }
  return (a >>> 0).toString(36) + ':' + (b >>> 0).toString(36);
}

export function duplicatesGate({ root, files, packages }) {
  const sources = files.filter((f) => SOURCE.test(f) && !f.endsWith('.d.ts') && !SKIP.test(f));
  const windows = new Map(); // hash -> [{ pkg, file, start }]
  const lines = new Map(); // file -> normalised lines
  for (const file of sources) {
    const pkg = SOURCE.exec(file)[1];
    const norm = normalise(readFileSync(join(root, file), 'utf8'));
    lines.set(file, norm);
    const lineHashes = norm.map((l) => hash(l.text));
    for (let i = 0; i + WINDOW <= norm.length; i++) {
      let chars = 0;
      for (let k = i; k < i + WINDOW; k++) chars += norm[k].text.length;
      if (chars < MIN_CHARS) continue;
      const key = hash(lineHashes.slice(i, i + WINDOW).join('|'));
      const list = windows.get(key);
      if (list) list.push({ pkg, file, start: i });
      else windows.set(key, [{ pkg, file, start: i }]);
    }
  }
  const covered = new Map(); // "a | b" -> Map(file -> Set(normalised index))
  for (const list of windows.values()) {
    const pkgs = [...new Set(list.map((o) => o.pkg))];
    if (pkgs.length < 2) continue;
    for (let x = 0; x < pkgs.length; x++)
      for (let y = x + 1; y < pkgs.length; y++) {
        const [a, b] = [pkgs[x], pkgs[y]].sort();
        const pair = `${a} | ${b}`;
        const files = covered.get(pair) ?? covered.set(pair, new Map()).get(pair);
        for (const o of list) {
          if (o.pkg !== a && o.pkg !== b) continue;
          const set = files.get(o.file) ?? files.set(o.file, new Set()).get(o.file);
          for (let k = o.start; k < o.start + WINDOW; k++) set.add(k);
        }
      }
  }
  const items = {};
  const blocks = {};
  for (const [pair, files] of covered) {
    let total = 0;
    blocks[pair] = [];
    for (const [file, set] of files) {
      total += set.size;
      const norm = lines.get(file);
      const sorted = [...set].sort((p, q) => p - q);
      let from = sorted[0];
      for (let i = 1; i <= sorted.length; i++)
        if (i === sorted.length || sorted[i] !== sorted[i - 1] + 1) {
          blocks[pair].push(`${file}:${norm[from].line}-${norm[sorted[i - 1]].line}`);
          from = sorted[i];
        }
    }
    items[pair] = total;
  }

  // Cross-package value re-exports from the entry sources.
  const reexports = [];
  for (const pkg of packages)
    for (const entry of pkg.entries) {
      if (!entry.src) continue;
      const { program } = parseSync(entry.src, readFileSync(join(root, entry.src), 'utf8'));
      for (const node of program.body) {
        const spec = node.source?.value;
        if (!spec || !(spec === 'margoengine' || spec.startsWith('@margoengine/')) || spec.startsWith(pkg.name))
          continue;
        if (node.exportKind === 'type') continue;
        if (node.type === 'ExportAllDeclaration') reexports.push(`reexport ${entry.src} * from ${spec}`);
        else if (node.type === 'ExportNamedDeclaration')
          for (const s of node.specifiers ?? [])
            if (s.exportKind !== 'type')
              reexports.push(`reexport ${entry.src} ${s.exported.name ?? s.exported.value} from ${spec}`);
      }
    }
  for (const key of reexports) items[key] = 1;

  // Known families: one algorithm rewritten in several packages, which line windows miss. Item per package holding
  // a copy, for families found in two or more packages.
  const families = {};
  for (const file of sources) {
    const pkg = SOURCE.exec(file)[1];
    const text = readFileSync(join(root, file), 'utf8');
    for (const [name, pattern] of Object.entries(FAMILIES))
      if (pattern.test(text)) (families[name] ??= new Set()).add(pkg);
  }
  for (const [name, pkgs] of Object.entries(families))
    if (pkgs.size > 1) for (const pkg of pkgs) items[`family ${name} ${pkg}`] = 1;

  // One block from each side of a pair, for messages.
  const sides = (pair) =>
    pair.split(' | ').map((pkg) => blocks[pair].find((b) => b.startsWith(`packages/${pkg}/`)) ?? pkg);
  return {
    items,
    details: { blocks },
    sides,
    summary() {
      return Object.entries(items)
        .filter(([k]) => !k.startsWith('reexport '))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([pair, n]) => `  ${pair}: ${n} lines, e.g. ${sides(pair).join(' ~ ')}`)
        .concat(
          Object.entries(families)
            .filter(([, p]) => p.size > 1)
            .map(([name, p]) => `  family ${name}: ${p.size} packages (${[...p].join(', ')})`),
          reexports.map((k) => `  ${k}`),
        );
    },
  };
}
