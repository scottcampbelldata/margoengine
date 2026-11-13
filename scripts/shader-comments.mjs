// Shader comments come out of every package dist at build time (KB-WGSL1). The sources keep them for readers; the
// shipped JavaScript and declarations carry only the shader tokens, so users download no comment text.
//
// Grammar, exactly as the specs give it:
// - WGSL (W3C WebGPU Shading Language, section 3.3 "Comments", https://www.w3.org/TR/WGSL/#comments; line breaks from
//   section 3.2 "Blankspace and Line Breaks", https://www.w3.org/TR/WGSL/#blankspace-and-line-breaks): a line-ending
//   comment runs from `//` up to, not including, the next line break (U+000A, U+000B, U+000C, U+000D, U+0085, U+2028,
//   U+2029) or the end of the program; a block comment runs from `/*` to its matching `*/` and nests. WGSL has no string
//   or character literals, so outside a comment every `//` and `/*` opens one. A comment does not change a program's
//   meaning, except that it separates tokens.
// - GLSL ES (OpenGL ES Shading Language 3.00.6, section 3.4 "Comments"): the same two forms, but block comments do not
//   nest, and a comment counts as one space. GLSL also joins a line ending in a backslash to the next (section 3.2), so
//   GLSL text holding any backslash is left whole.
//
// The rewrite: a block comment becomes the line breaks it held, or one space when it held none (nothing when blankspace
// already sits beside it); a line comment goes with the spaces and tabs before it and keeps its line break. Every token
// keeps its text, its order and its line (WebGPU compilation messages and the inspector's error placement count lines);
// only columns after a block comment on the same line move.
//
// Shader text is a JavaScript string literal or untagged template literal that classifies as WGSL or GLSL below. A
// template literal's interpolations are opaque: each piece between them is rewritten on its own, and a literal any of
// whose pieces ends inside a comment (one that would run on into an interpolation or a later concatenation) is left
// whole, as is a tagged template (its tag can read the raw text). Some code finds its place in a shader by comment text
// (`code.split('//INDICES')`, `edit('// One lobe', ...)`): a comment that starts with the comment text of any other
// string in the package's sources is an anchor and stays. Every rewrite is checked token for token with shaderTokens
// before it is written, so a build cannot ship a changed shader.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseSync } from 'rolldown/utils';

const LINE_BREAK = { wgsl: /[\n\v\f\r\u0085\u2028\u2029]/, glsl: /[\n\r]/ };
const HORIZONTAL = { wgsl: /[ \t\u200e\u200f]$/, glsl: /[ \t]$/ };
const BLANK = { wgsl: /[\t\n\v\f\r \u0085\u200e\u200f\u2028\u2029]/, glsl: /[\t\n\v\f\r ]/ };

const WGSL_STRONG =
  /\bfn\s+\w+\s*\(|@(vertex|fragment|compute|group|binding|builtin|location|workgroup_size|interpolate|must_use|diagnostic)\b|\bvar<(storage|uniform|private|workgroup|function)\b|\bstruct\s+\w+\s*\{\s*(@\w+(\([^)]*\))?\s*)*\w+\s*:/;
const WGSL_FRAGMENT_STATEMENT = /\b(let|var|const)\s+\w+\s*(:\s*[\w<>, ]+)?\s*=[^=]/;
const WGSL_FRAGMENT_TYPE =
  /\b(vec[234][fiuh]|vec[234]<|mat[234]x[234][fh]?|f32|u32|i32|f16|array<|texture_\w+|textureSample\w*|textureLoad|unpack\w+|pack\w+)\b|\bselect\(/;
const GLSL =
  /#version\b|\bvoid\s+main\s*\(|\bgl_[A-Z]\w*|\bprecision\s+(lowp|mediump|highp)\b|\b(uniform|attribute|varying|in|out)\s+(lowp\s+|mediump\s+|highp\s+)?(vec[234]|ivec[234]|uvec[234]|float|int|mat[234]|sampler2D|sampler3D|samplerCube)\b/;
// Other languages Margo writes into strings (JavaScript workers, C#, Rust, Python): never shader text. (`function`
// alone is a WGSL address space, as in ptr<function, T>; a JavaScript function has a parenthesis.)
const OTHER =
  /\bfunction\s*\w*\s*\(|=>|\bthis\.|===|::|\busing\s+System\b|\bnamespace\b|\bpub\s+(const|fn|struct)\b|"""|\bdef\s+\w+\s*\(|\brequire\(/;
const OPENER = /\/\/|\/\*/;

/** 'wgsl', 'glsl' or null for text (a template literal's pieces joined) that holds a comment opener. */
export function shaderLanguage(text) {
  if (!OPENER.test(text)) return null;
  // Judged on the text outside comments (cut roughly here; the rewrite itself follows the grammar exactly).
  const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ');
  if (OTHER.test(code)) return null;
  const wgsl = WGSL_STRONG.test(code) || (WGSL_FRAGMENT_STATEMENT.test(code) && WGSL_FRAGMENT_TYPE.test(code));
  const glsl = GLSL.test(code);
  if (wgsl === glsl) return null;
  return wgsl ? 'wgsl' : 'glsl';
}

const none = () => false;

/**
 * Removes the comments from one piece of shader text. Returns { text, comments, open, prose }: `open` when the piece
 * ends inside a comment, `prose` when a `word://` URL shows it is text about shader code (the caller then leaves the
 * literal whole), `comments` the number removed. `anchor(comment)` true keeps that comment as written.
 */
export function stripComments(source, language, anchor = none) {
  assert.ok(language === 'wgsl' || language === 'glsl', `unknown shader language ${language}`);
  const lineBreak = LINE_BREAK[language],
    horizontal = HORIZONTAL[language],
    blank = BLANK[language];
  const whole = (open, prose) => ({ text: source, comments: 0, open, prose });
  let out = '',
    i = 0,
    comments = 0;
  const trimLine = () => {
    while (out && horizontal.test(out)) out = out.slice(0, -1);
  };
  while (i < source.length) {
    const line = source.startsWith('//', i);
    if (!line && !source.startsWith('/*', i)) {
      out += source[i++];
      continue;
    }
    // A URL outside a comment is not WGSL or GLSL, so this is prose that names shader code.
    if (line && /\w:$/.test(source.slice(Math.max(0, i - 2), i))) return whole(false, true);
    let end = i + 2;
    if (line) {
      while (end < source.length && !lineBreak.test(source[end])) end++;
      // The piece ends inside the comment: what follows it at run time may be the rest of that comment.
      if (end === source.length) return whole(true, false);
    } else {
      let depth = 1;
      while (end < source.length && depth > 0)
        if (language === 'wgsl' && source.startsWith('/*', end)) (depth++, (end += 2));
        else if (source.startsWith('*/', end)) (depth--, (end += 2));
        else end++;
      if (depth > 0) return whole(true, false);
    }
    const comment = source.slice(i, end);
    i = end;
    if (anchor(comment)) {
      out += comment;
      continue;
    }
    comments++;
    if (line) trimLine();
    else {
      const breaks = [...comment].filter((c) => lineBreak.test(c)).join('');
      if (breaks) {
        trimLine();
        out += breaks;
      } else if (i < source.length && lineBreak.test(source[i])) trimLine();
      else if (out && blank.test(out.at(-1))) {
        // Blankspace on both sides: one side separates the tokens.
        if (i < source.length && horizontal.test(source[i])) i++;
      } else if (!(i < source.length && blank.test(source[i]))) out += ' ';
    }
  }
  return { text: out, comments, open: false, prose: false };
}

// Shader tokens, each as [line, text]; a template literal's interpolations are one opaque token. Written apart from
// stripComments, with its own comment skipping, so the two cannot share a mistake.
const PUNCTUATION = [
  '>>=', '<<=', '->', '&&', '||', '==', '!=', '<=', '>=', '<<', '>>', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=',
  '|=', '^=', '##',
];
const NUMBER =
  /^(0[xX]([0-9a-fA-F]*\.[0-9a-fA-F]*|[0-9a-fA-F]+)([pP][+-]?\d+)?[fhiu]?|(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?[fhiulU]?)/;
const WORD = /^[\p{XID_Start}_][\p{XID_Continue}]*/u;
/** Stands for a template literal's interpolation when its pieces are joined. */
export const INTERPOLATION = '\u0000';

/** The shader tokens of `text` as [line, token] pairs: comments and blankspace separate tokens and are dropped. */
export function shaderTokens(text, language) {
  const lineBreak = LINE_BREAK[language],
    blank = BLANK[language],
    tokens = [];
  let line = 1,
    i = 0;
  const newline = () => {
    i += text[i] === '\r' && text[i + 1] === '\n' ? 2 : 1;
    line++;
  };
  while (i < text.length) {
    const c = text[i];
    if (lineBreak.test(c)) newline();
    else if (blank.test(c)) i++;
    else if (text.startsWith('//', i)) while (i < text.length && !lineBreak.test(text[i])) i++;
    else if (text.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (depth > 0 && i < text.length)
        if (language === 'wgsl' && text.startsWith('/*', i)) (depth++, (i += 2));
        else if (text.startsWith('*/', i)) (depth--, (i += 2));
        else if (lineBreak.test(text[i])) newline();
        else i++;
    } else {
      const token =
        c === INTERPOLATION
          ? c
          : (NUMBER.exec(text.slice(i, i + 64))?.[0] ??
            WORD.exec(text.slice(i, i + 256))?.[0] ??
            PUNCTUATION.find((p) => text.startsWith(p, i)) ??
            c);
      tokens.push([line, token]);
      i += token.length;
    }
  }
  return tokens;
}

/** True when `before` and `after` hold the same shader tokens on the same lines. */
export const sameTokens = (before, after, language) =>
  JSON.stringify(shaderTokens(before, language)) === JSON.stringify(shaderTokens(after, language));

const escapeTemplate = (text) =>
  text.replace(/\\|`|\$\{|\r/g, (m) => (m === '\r' ? '\\r' : m === '${' ? '\\${' : `\\${m}`));

/** Calls visit(node, pieces) for every string literal (one piece) and template literal of a parsed program. */
function eachLiteral(program, visit) {
  const walk = (node, parent) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, parent);
      return;
    }
    if (node.type === 'Literal' && typeof node.value === 'string') visit(node, [node.value], parent);
    else if (node.type === 'TemplateLiteral') visit(node, node.quasis.map((q) => q.value.cooked), parent);
    for (const key in node) if (key !== 'type' && node[key] && typeof node[key] === 'object') walk(node[key], node);
  };
  walk(program, null);
}

/**
 * The comment texts that code in these source files searches shader text for: every comment opener inside a string
 * that is not shader text itself, up to the end of its line (or its `*` `/`), URLs left out.
 */
export function anchorTexts(files) {
  const anchors = new Set();
  for (const [filename, code] of files) {
    if (!OPENER.test(code)) continue;
    const parsed = parseSync(filename, code);
    assert.equal(parsed.errors.length, 0, `Cannot parse ${filename} for shader comment anchors`);
    eachLiteral(parsed.program, (_node, pieces) => {
      if (pieces.some((p) => typeof p !== 'string') || shaderLanguage(pieces.join(INTERPOLATION))) return;
      for (const piece of pieces)
        for (const m of piece.matchAll(/(?<![\w:/])\/\/[^\n]*|\/\*([^*]|\*(?!\/))*(\*\/)?/g)) {
          const text = m[0].trimEnd();
          // A bare opener (a tokenizer looking for comments) anchors nothing.
          if (/^(\/\/|\/\*)[\s/*]*$/.test(text)) continue;
          anchors.add(text);
        }
    });
  }
  return [...anchors];
}

/** The anchor texts of a package, read from every source file under its src/ (once per build). */
export function packageAnchors(root) {
  const files = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(m?[jt]sx?)$/.test(entry.name) && !entry.name.endsWith('.d.ts'))
        files.push([path, readFileSync(path, 'utf8')]);
    }
  };
  walk(join(root, 'src'));
  return anchorTexts(files);
}

/**
 * Rewrites the shader literals of one JavaScript or declaration file. Returns { code, comments, kept }: `kept` lists the
 * shader literals with a comment left in (offset, why, text). `anchors` are comment texts to keep (packageAnchors);
 * `strip` is the piece rewriter, replaceable so tests can prove a broken one is caught.
 */
export function stripShaderLiterals(code, filename, { anchors = [], strip = stripComments } = {}) {
  const parsed = parseSync(filename, code);
  assert.equal(parsed.errors.length, 0, `Cannot parse ${filename} to strip shader comments`);
  const anchor = (comment) => anchors.some((text) => comment.startsWith(text));
  const edits = [],
    kept = [];
  let comments = 0;
  eachLiteral(parsed.program, (node, pieces, parent) => {
    if (pieces.some((p) => typeof p !== 'string')) return;
    const language = shaderLanguage(pieces.join(INTERPOLATION));
    if (!language) return;
    const keep = (why) => kept.push({ at: node.start, why, text: pieces.join('${...}') });
    if (parent?.type === 'TaggedTemplateExpression' && parent.quasi === node) return keep('tagged template');
    if (language === 'glsl' && pieces.some((p) => p.includes('\\'))) return keep('GLSL text with a backslash');
    const results = pieces.map((piece) => strip(piece, language, anchor));
    if (results.some((r) => r.prose)) return;
    if (results.some((r) => r.open)) return keep('a comment runs on past an interpolation or the end of the string');
    const count = results.reduce((sum, r) => sum + r.comments, 0);
    if (!count) return;
    const before = pieces.join(INTERPOLATION),
      after = results.map((r) => r.text).join(INTERPOLATION);
    assert.ok(sameTokens(before, after, language), `${filename}:${node.start}: stripping comments changed shader tokens`);
    comments += count;
    if (node.type === 'Literal') edits.push({ start: node.start, end: node.end, text: JSON.stringify(after) });
    else
      node.quasis.forEach((quasi, k) => {
        if (results[k].text !== pieces[k])
          edits.push({ start: quasi.start, end: quasi.end, text: escapeTemplate(results[k].text) });
      });
  });
  edits.sort((a, b) => b.start - a.start);
  let output = code;
  for (const edit of edits) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  return { code: output, comments, kept };
}

/**
 * The comments still inside shader literals of `code` (what the quality gate counts in shipped files): one entry per
 * comment that a strip would remove, plus every literal a strip leaves whole with a comment in it.
 */
export function shaderCommentsLeft(code, filename, anchors = []) {
  const { comments, kept } = stripShaderLiterals(code, filename, { anchors });
  return { comments, kept };
}

// KB-WGSL1 lands package by package, each batch with the GPU tests of the packages it strips: the packages stripped so
// far. It goes (null) once every package is; the shader-comments quality gate records what is left meanwhile.
const ROLLOUT = new Set(['cameras', 'compute', 'lod', 'robot-planning', 'taa', 'tonemap']);

/**
 * Applied after emission, beside declarePackageCore, by every package build: strips the shader comments of every .js
 * and .d.ts file under the package's dist. Returns the number of files rewritten and comments removed.
 */
export async function stripPackageShaderComments(root) {
  if (ROLLOUT && !ROLLOUT.has(basename(root))) return { files: 0, comments: 0 };
  const anchors = packageAnchors(root),
    total = { files: 0, comments: 0 };
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (/\.(m?js|d\.ts)$/.test(entry.name)) {
        const code = await readFile(path, 'utf8');
        const result = stripShaderLiterals(code, path, { anchors });
        if (result.code !== code) {
          await writeFile(path, result.code);
          total.files++;
          total.comments += result.comments;
        }
      }
    }
  }
  await visit(join(root, 'dist'));
  return total;
}
