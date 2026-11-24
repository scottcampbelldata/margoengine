import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const isManifest = (file) => file === 'package.json' || /^packages\/[^/]+\/package\.json$/.test(file);

// Strict JSON scan that reports the line of the first syntax error and of every repeated key in an object.
export function jsonProblems(text) {
  const problems = [];
  let i = 0;
  let line = 1;
  const fail = (message) => {
    problems.push(`line ${line}: ${message}`);
    return null;
  };
  const ws = () => {
    while (i < text.length && /[ \t\r\n]/.test(text[i])) if (text[i++] === '\n') line++;
  };
  const string = () => {
    const start = i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\n') return fail('newline inside a string');
      i += text[i] === '\\' ? 2 : 1;
    }
    if (i >= text.length) return fail('unterminated string');
    i++;
    try {
      return JSON.parse(text.slice(start, i));
    } catch {
      return fail('invalid string escape');
    }
  };
  const value = () => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const seen = new Set();
      ws();
      if (text[i] === '}') return i++, true;
      for (;;) {
        ws();
        if (text[i] !== '"') return fail(`expected a key but found ${text[i] ?? 'end of file'}`);
        const keyLine = line;
        const key = string();
        if (key === null) return null;
        if (seen.has(key)) problems.push(`line ${keyLine}: duplicate key "${key}"`);
        seen.add(key);
        ws();
        if (text[i++] !== ':') return fail('expected ":" after key');
        if (value() === null) return null;
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') return i++, true;
        return fail(`expected "," or "}" but found ${text[i] ?? 'end of file'}`);
      }
    }
    if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') return i++, true;
      for (;;) {
        if (value() === null) return null;
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') return i++, true;
        return fail(`expected "," or "]" but found ${text[i] ?? 'end of file'}`);
      }
    }
    if (c === '"') return string() === null ? null : true;
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!m) return fail(`unexpected ${c ?? 'end of file'}`);
    i += m[0].length;
    return true;
  };
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  if (value() !== null) {
    ws();
    if (i < text.length) fail('unexpected content after the JSON value');
  }
  return problems;
}

// files: tracked paths; read: path -> text. Returns "file:line message" findings.
export function manifestProblems(files, read) {
  const out = [];
  for (const file of files.filter(isManifest))
    for (const p of jsonProblems(read(file))) out.push(`${file}: ${p}`);
  return out;
}

export function assertValidManifests(files, read) {
  const findings = manifestProblems(files, read);
  if (findings.length)
    throw new Error(`Invalid package manifest (bad JSON or duplicate key); fix these:\n${findings.join('\n')}`);
}

export function assertValidTrackedManifests(root) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 32 << 20 })
    .split('\0')
    .filter((f) => f && existsSync(join(root, f)));
  assertValidManifests(files, (f) => readFileSync(join(root, f), 'utf8'));
}
