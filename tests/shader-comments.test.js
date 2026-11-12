// KB-WGSL1: the build strips comments from the shader strings it ships (scripts/shader-comments.mjs). These tests hold
// the strip to the WGSL and GLSL comment grammar, prove on every shader in packages/*/src that the token stream (text,
// order and line of every token) is the same before and after, and prove that a broken strip is caught.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  anchorTexts,
  packageAnchors,
  shaderLanguage,
  shaderTokens,
  stripComments,
  stripShaderLiterals,
} from '../scripts/shader-comments.mjs';

const root = resolve(import.meta.dirname, '..');
const wgsl = (text, anchor) => stripComments(text, 'wgsl', anchor);

test('WGSL line comments go up to the line break and keep it (WGSL 3.3)', () => {
  assert.deepEqual(wgsl('let a = 1; // one\nlet b = 2;\n'), {
    text: 'let a = 1;\nlet b = 2;\n',
    comments: 1,
    open: false,
    prose: false,
  });
  // Every WGSL line break ends one (3.2): CR, CR LF, VT, FF, NEL, LS, PS.
  for (const end of ['\r', '\r\n', '\v', '\f', '\u0085', '\u2028', '\u2029'])
    assert.equal(wgsl(`let a = 1; // x${end}let b = 2;${end}`).text, `let a = 1;${end}let b = 2;${end}`);
  // A comment-only line keeps its line, empty.
  assert.equal(wgsl('fn f() {\n    // note\n  return;\n}\n').text, 'fn f() {\n\n  return;\n}\n');
});

test('WGSL block comments nest and become their line breaks or one separating space (WGSL 3.3)', () => {
  assert.equal(wgsl('a/* x /* y */ z */b;\n').text, 'a b;\n');
  assert.equal(wgsl('a /* x */ b;\n').text, 'a b;\n');
  assert.equal(wgsl('a; /* x */\nb;\n').text, 'a;\nb;\n');
  assert.equal(wgsl('let a = 1; /* one\ntwo\r\nthree */ let b = 2;\n').text, 'let a = 1;\n\r\n let b = 2;\n');
  assert.equal(wgsl('x/**/y').text, 'x y');
  assert.equal(wgsl('x/*/ still open */y').text, 'x y');
  // `*/` inside a line comment and `//` inside a block comment are comment text.
  assert.equal(wgsl('a; // */ b\nc;\n').text, 'a;\nc;\n');
  assert.equal(wgsl('a; /* // b */ c;\n').text, 'a; c;\n');
});

test('GLSL block comments do not nest; a backslash leaves the text whole (GLSL ES 3.00.6, 3.2 and 3.4)', () => {
  assert.equal(stripComments('a /* x /* y */ b;\n', 'glsl').text, 'a b;\n');
  // The JavaScript below holds `\\` before the newline, so the shader text itself ends that line with a backslash.
  const literal = 'const s = `#version 300 es\nvoid main() { // x \\\\\n gl_Position = vec4(0.0); }\n`;';
  const { code, kept } = stripShaderLiterals(literal, 'x.js');
  assert.equal(code, literal);
  assert.equal(kept[0].why, 'GLSL text with a backslash');
});

test('a piece that ends inside a comment, a URL in prose and a tagged template are left whole', () => {
  assert.equal(wgsl('let a = 1; // runs into ${n}').open, true);
  assert.equal(wgsl('let a = 1; /* runs on').open, true);
  assert.equal(wgsl('fn f(x: f32) see https://margoengine.com/errors#x').prose, true);
  const source = [
    'const crossing = `fn f() -> f32 { // uses ${lanes} lanes\n return 1.0; }`;',
    'const tagged = wgsl`fn f() -> f32 { // a\n return 1.0; }`;',
    'const message = `fn main( is missing; see https://margoengine.com/errors#shader`;',
  ].join('\n');
  const { code, kept } = stripShaderLiterals(source, 'x.js');
  assert.equal(code, source);
  assert.deepEqual(
    kept.map((k) => k.why),
    ['a comment runs on past an interpolation or the end of the string', 'tagged template'],
  );
});

test('interpolations stay opaque and escapes survive the rewrite', () => {
  const source = 'const s = `fn f() -> vec3f { // x\n  return ${a}/* y */${b}; // \\`q\\` and \\${z}\n}`;';
  const { code } = stripShaderLiterals(source, 'x.js');
  assert.equal(code, 'const s = `fn f() -> vec3f {\n  return ${a} ${b};\n}`;');
  const quoted = 'const s = "@compute @workgroup_size(1) fn main() { // x\\n}\\n";';
  assert.equal(stripShaderLiterals(quoted, 'x.js').code, 'const s = "@compute @workgroup_size(1) fn main() {\\n}\\n";');
});

test('a comment that code searches for by text is an anchor and stays', () => {
  const files = [
    ['a.ts', "const [setup, index] = code.split('//INDICES'); const fix = s.replace('/*lod:direct*/', d);"],
    ['b.ts', "if (text.startsWith('//', at)) skip(); const url = 'https://margoengine.com/x';"],
  ];
  assert.deepEqual(anchorTexts(files), ['//INDICES', '/*lod:direct*/']);
  const anchor = (c) => ['//INDICES', '/*lod:direct*/'].some((a) => c.startsWith(a));
  assert.equal(
    wgsl('let a = 1; // note\n//INDICES\nlet b = 2; /*lod:direct*/ /* c */\n', anchor).text,
    'let a = 1;\n//INDICES\nlet b = 2; /*lod:direct*/\n',
  );
});

test('only shader text is rewritten: JavaScript, C#, Rust and prose strings keep their comments', () => {
  assert.equal(shaderLanguage('fn main() { // x\n}'), 'wgsl');
  assert.equal(shaderLanguage('let a: vec3f = b; // x\n'), 'wgsl');  assert.equal(shaderLanguage('fn f(p: ptr<function, vec3u>) { // x\n}'), 'wgsl');
  assert.equal(shaderLanguage('#version 300 es\nvoid main() { // x\n}'), 'glsl');
  assert.equal(shaderLanguage('class P extends AudioWorkletProcessor { process() { let a = 1; } } // x'), null);
  assert.equal(shaderLanguage('using System;\nnamespace M { // x\n}'), null);
  assert.equal(shaderLanguage('/// doc\npub const SCHEMA_HASH:u32=1;'), null);
  assert.equal(shaderLanguage('VFX nodes value is not a finite f32; see https://margoengine.com/errors#vfx-float'), null);
});

// Every shader literal in the packages' sources: the text the build ships, piece by piece.
function sourceFiles() {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(m?[jt]sx?)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(path);
    }
  };
  for (const dir of readdirSync(join(root, 'packages'))) {
    try {
      walk(join(root, 'packages', dir, 'src'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return files;
}
const corpus = sourceFiles().map((path) => [path, readFileSync(path, 'utf8')]);
const anchorsOf = new Map();
const anchorsFor = (path) => {
  const dir = path.slice(join(root, 'packages').length + 1).split(/[\\/]/)[0];
  if (!anchorsOf.has(dir)) anchorsOf.set(dir, packageAnchors(join(root, 'packages', dir)));
  return anchorsOf.get(dir);
};

/** Strips the whole corpus with `strip`; returns the pieces it rewrote and the token mismatches this test finds. */
function stripCorpus(strip) {
  let pieces = 0,
    removed = 0;
  const mismatches = [];
  for (const [path, code] of corpus) {
    if (!/\/\/|\/\*/.test(code)) continue;
    const record = (piece, language, anchor) => {
      const result = strip(piece, language, anchor);
      if (!result.open && !result.prose && result.text !== piece) {
        pieces++;
        removed += piece.length - result.text.length;
        const before = shaderTokens(piece, language),
          after = shaderTokens(result.text, language);
        try {
          assert.deepEqual(after, before);
        } catch {
          mismatches.push(`${path}: ${JSON.stringify(piece.slice(0, 80))}`);
        }
      }
      return result;
    };
    try {
      stripShaderLiterals(code, path, { anchors: anchorsFor(path), strip: record });
    } catch (error) {
      // The build's own check refuses a changed shader; the mismatch is already recorded above.
      if (!/changed shader tokens/.test(error.message)) throw error;
    }
  }
  return { pieces, removed, mismatches };
}

test('every shader in packages/*/src keeps its exact token stream and lines', () => {
  const { pieces, removed, mismatches } = stripCorpus(stripComments);
  assert.deepEqual(mismatches, []);
  // 266 pieces and 87,795 characters of comment text when this landed (KB-WGSL1); far fewer means the classifier broke.
  console.log(`shader-comments corpus: ${pieces} pieces, ${removed} characters of comments`);
  assert.ok(pieces > 200, `only ${pieces} shader pieces rewritten`);
  assert.ok(removed > 70_000, `only ${removed} characters of comments found`);
});

test('a broken strip is caught on the real shaders', () => {
  const broken = {
    // Line comments take their line break with them: every later token moves up a line.
    'eats line breaks': (piece, language, anchor) => {
      const r = stripComments(piece, language, anchor);
      return r.open || r.prose ? r : { ...r, text: piece.replace(/[ \t]*\/\/[^\n]*\n/g, '') };
    },
    // Each comment takes the token after it too.
    'eats a token': (piece, language, anchor) => {
      const r = stripComments(piece, language, anchor);
      return r.open || r.prose ? r : { ...r, text: piece.replace(/\/\/[^\n]*\n\s*\w+/g, '\n') };
    },
  };
  for (const [name, strip] of Object.entries(broken))
    assert.ok(stripCorpus(strip).mismatches.length > 0, `the ${name} strip was not caught`);
  // Shapes the corpus may lack: joined tokens and non-nested WGSL blocks.
  const joins = (p, l) => ({ ...stripComments(p, l), text: p.replace(/\/\*.*?\*\//g, '') });
  assert.throws(() => stripShaderLiterals('const s = `fn f() { a/* x */b; // y\n}`;', 'x.js', { strip: joins }));
  const flat = (p, l) => ({ ...stripComments(p, l), text: p.replace(/\/\*[\s\S]*?\*\//g, ' ') });
  assert.throws(() => stripShaderLiterals('const s = `fn f() { a /* x /* y */ z */ b; // y\n}`;', 'x.js', { strip: flat }));
});
