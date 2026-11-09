// Clean-room class check: production launchers may request exclusive GPU access only for speed work.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createScanner } from 'typescript/unstable/ast/scanner';
import { SyntaxKind } from 'typescript/unstable/ast';
import { measuresSpeed } from './gpu-lock.mjs';
import { exitOnHelp } from './support/help.mjs';

const root = resolve(import.meta.dirname, '..');
const scheduler = new Set(['scripts/gpu-lock.mjs', 'scripts/gpu-queue.mjs']);
const speedFiles = new Set([
  ...JSON.parse(readFileSync(new URL('./speed/cases.json', import.meta.url))).map((r) => r.file),
  ...JSON.parse(readFileSync(new URL('./speed/suites.json', import.meta.url))).map((r) => r.id),
]);
const speed = (command) => measuresSpeed(command.replaceAll('\\', '/').split(/[\s'"`,;\[\]()]+/));

/** Inspect executable syntax, not comments or documentation. Tests supply their own speed inventory. */
export function policyViolations(file, text, inventory = speedFiles) {
  if (
    scheduler.has(file) ||
    file.startsWith('docs/whitepaper/results/') ||
    /(?:^|\/)fixtures\//.test(file) ||
    /\.test\.[cm]?[jt]s$/.test(file)
  )
    return [];
  const errors = [];
  const report = (line, request) => errors.push({ file, line, request, code: 'ERR_GPU_POLICY_EXCLUSIVE' });
  const approved = (command) => speed(command) || /--timing=\S+/.test(command);
  if (file.endsWith('package.json')) {
    for (const [name, command] of Object.entries(JSON.parse(text).scripts ?? {})) {
      if (
        (/--exclusive\b/.test(command) || /MARGO_GPU_EXCLUSIVE\s*[:=]\s*['"]?(?:1|true|yes)/i.test(command)) &&
        !/^bench/.test(name) &&
        !approved(command)
      )
        report(1, `${name}: ${command}`);
    }
    return errors;
  }
  if (!/\.[cm]?[jt]sx?$/.test(file)) return errors;
  if (!/gpu-lock|--exclusive|MARGO_GPU_EXCLUSIVE/.test(text)) return errors;
  // TypeScript 7's scanner is local and comment-aware; no compiler process or project is needed.
  const scanner = createScanner(true);
  scanner.setText(text);
  const tokens = [];
  let previousEnd = -1;
  let braces = 0;
  const templates = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    const previous = tokens.at(-1)?.text;
    if (
      kind === SyntaxKind.SlashToken &&
      (!previous ||
        [SyntaxKind.TemplateHead, SyntaxKind.TemplateMiddle].includes(tokens.at(-1)?.kind) ||
        /^(?:[=([{,:;!?]|=>|return|throw|case|yield)$/.test(previous))
    )
      kind = scanner.reScanSlashToken();
    if (kind === SyntaxKind.CloseBraceToken && templates.at(-1) === braces) {
      kind = scanner.reScanTemplateToken(false);
      if (kind === SyntaxKind.TemplateTail) templates.pop();
    } else if (kind === SyntaxKind.OpenBraceToken) braces++;
    else if (kind === SyntaxKind.CloseBraceToken) braces--;
    if (kind === SyntaxKind.TemplateHead) templates.push(braces);
    if (scanner.getTokenEnd() <= previousEnd) throw new Error(`GPU policy scanner stopped at ${file}:${previousEnd}`);
    previousEnd = scanner.getTokenEnd();
    const quoted = kind === SyntaxKind.StringLiteral || kind === SyntaxKind.NoSubstitutionTemplateLiteral;
    tokens.push({
      kind,
      text: scanner.getTokenText(),
      value: quoted ? scanner.getTokenValue() : undefined,
      pos: scanner.getTokenStart(),
    });
  }
  const acquisitions = new Set();
  const code = tokens.map((t) => t.text).join(' ');
  for (const match of code.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"][^'"]*gpu-lock\.mjs['"]/g))
    for (const item of match[1].split(',')) {
      const name = /^\s*acquire(?:\s+as\s+(\w+))?\s*$/.exec(item);
      if (name) acquisitions.add(name[1] ?? 'acquire');
    }
  const sourceIsSpeed = speed(file) || inventory.has(file);
  const statement = (i) => {
    let first = i,
      last = i;
    while (first > 0 && tokens[first - 1].text !== ';') first--;
    while (last < tokens.length && tokens[last].text !== ';') last++;
    return tokens
      .slice(first, last)
      .map((t) => t.text)
      .join(' ');
  };
  const line = (token) => text.slice(0, token.pos).split('\n').length;
  for (const [i, token] of tokens.entries()) {
    if (sourceIsSpeed) continue;
    if (
      acquisitions.has(token.text) &&
      tokens[i + 1]?.text === '(' &&
      /\bmode\s*:\s*['"]exclusive['"]/.test(statement(i))
    )
      report(line(token), statement(i));
    if (
      (token.kind === SyntaxKind.StringLiteral || token.kind === SyntaxKind.NoSubstitutionTemplateLiteral) &&
      /--exclusive\b/.test(token.value) &&
      !approved(statement(i))
    )
      report(line(token), token.value);
    if (
      (token.value ?? token.text) === 'MARGO_GPU_EXCLUSIVE' &&
      /[:=]/.test(tokens[i + 1]?.text ?? '') &&
      /^(1|true|yes)$/i.test(tokens[i + 2]?.value ?? tokens[i + 2]?.text ?? '')
    )
      report(line(token), statement(i));
  }
  return errors;
}

export function checkGpuPolicy(dir = root) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: dir, encoding: 'utf8', timeout: 30_000 })
    .split('\0')
    .filter(Boolean);
  return files.flatMap((file) =>
    /(?:^|\/)package\.json$|\.[cm]?[jt]sx?$/.test(file)
      ? policyViolations(file, readFileSync(resolve(dir, file), 'utf8'))
      : [],
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  exitOnHelp(
    'usage: node scripts/check-gpu-policy.mjs\nChecks production exclusive GPU requests against the speed inventory.',
  );
  const errors = checkGpuPolicy();
  for (const error of errors) console.error(`${error.code}: ${error.file}:${error.line}: ${error.request}`);
  if (errors.length) process.exitCode = 1;
  else console.log('GPU policy: every production exclusive request is classified speed work');
}
