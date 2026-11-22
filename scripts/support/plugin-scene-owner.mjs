// A plugin leaves the scene it was attached to, never the active one (docs/integration-fixtures.md, "Scene owner").
// `engine.removePlugin(name)` with one argument removes `name` from the engine's ACTIVE scene: a plugin attached to a
// second scene stays behind there (its passes keep running on freed resources) and a plugin of the same name in the
// active scene is torn down instead. The form that is right in every scene is
// `engine.sceneOf(plugin)?.removePlugin(plugin.name)`, or `engine.removePlugin(name, scene)` with the scene it joined.
// This check finds every one-argument `.removePlugin(` call on an engine (an identifier or member named engine,
// #engine, runtime or kernel) in packages/*/src, the whole class at once. `npm run hygiene` fails on a finding;
// tests/plugin-scene-owner.test.js holds its self-test.
//
// Two ways past it, both explicit:
// - OPEN below: a known open site, by file and exact call, with the docs/known-bugs.md entry that holds its repro.
//   A listed site that no longer matches also fails, so the list shrinks with each fix.
// - A `// scene-owner: active scene on purpose, <reason>` comment on the line above a call whose active-scene removal
//   is the intent (the reason is required).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync } from 'rolldown/utils';

const PHYSICS = 'docs/known-bugs.md, "plugin scene owner (physics)": physics is on hold';
const SCIVIZ = 'docs/known-bugs.md, "plugin scene owner (sciviz)": sciviz is held out of list 5';
/** Every open site the check lets through, each by file, exact call text and the known-bugs entry. */
export const OPEN = [
  { file: 'packages/physics/src/next/physics.ts', call: 'engine.removePlugin(this.name)', bug: PHYSICS },
  { file: 'packages/sciviz/src/progressive.ts', call: 'this.#engine?.removePlugin(this.name)', bug: SCIVIZ },
  { file: 'packages/sciviz/src/render.ts', call: 'engine?.removePlugin(this.name)', bug: SCIVIZ },
];
const ENGINE = /^(?:engine|runtime|kernel)$/i;
const ON_PURPOSE = /\/\/\s*scene-owner: active scene on purpose, \S/;

function receiverName(node) {
  if (node?.type === 'ChainExpression') return receiverName(node.expression);
  if (node?.type === 'ParenthesizedExpression') return receiverName(node.expression);
  if (['TSNonNullExpression', 'TSAsExpression', 'TSSatisfiesExpression'].includes(node?.type))
    return receiverName(node.expression);
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'MemberExpression' || node?.type === 'StaticMemberExpression') return node.property?.name;
  if (node?.type === 'PrivateFieldExpression') return node.field?.name;
  return undefined;
}

/**
 * `[{ line, text }]`: each one-argument removePlugin call on an engine in `source` (file name gives the syntax),
 * except one whose previous line is a `// scene-owner: active scene on purpose, <reason>` comment.
 */
export function engineRemovals(source, file = 'source.ts') {
  const { program, errors } = parseSync(file.replace(/\.(m?js)$/, '.ts'), source);
  if (errors?.length && !program?.body?.length) throw new Error(`${file}: cannot parse: ${errors[0].message}`);
  const found = [];
  const lines = source.split('\n');
  const lineOf = (offset) => source.slice(0, offset).split('\n').length;
  (function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression') {
      let callee = node.callee;
      if (callee?.type === 'ChainExpression') callee = callee.expression;
      const property = callee?.property?.name;
      if (property === 'removePlugin' && node.arguments.length === 1) {
        const name = receiverName(callee.object);
        const line = lineOf(node.start);
        if (name && ENGINE.test(name.replace(/^#/, '')) && !ON_PURPOSE.test(lines[line - 2] ?? ''))
          found.push({ line, text: source.slice(node.start, node.end) });
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const child of value) visit(child);
      else if (value && typeof value === 'object' && value !== node) visit(value);
    }
  })(program);
  return found;
}

/**
 * Every finding in the tracked package sources under `root`, as `file:line: text`, the OPEN sites left out, plus a
 * finding for each OPEN entry that no longer matches (fixed or moved: take it off the list and its known-bugs entry).
 */
export function pluginSceneOwnerFindings(root, open = OPEN) {
  const files = execFileSync('git', ['ls-files', '-z', '--', 'packages/*/src/**'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 32 << 20,
  })
    .split('\0')
    .filter((f) => /\.(ts|js|mjs)$/.test(f) && !f.endsWith('.d.ts'));
  const findings = [];
  const matched = new Set();
  for (const file of files) {
    const source = readFileSync(join(root, file), 'utf8');
    if (!source.includes('removePlugin(')) continue;
    for (const { line, text } of engineRemovals(source, file)) {
      const site = open.find((o) => o.file === file && o.call === text);
      if (site) matched.add(site);
      else findings.push(`${file}:${line}: ${text}`);
    }
  }
  for (const site of open)
    if (!matched.has(site)) findings.push(`${site.file}: listed open site "${site.call}" is gone; drop it from OPEN`);
  return findings;
}

export function assertPluginsLeaveOwnScene(root) {
  const findings = pluginSceneOwnerFindings(root);
  if (findings.length)
    throw new Error(
      `A plugin is removed from the active scene, not its own (use engine.sceneOf(plugin)?.removePlugin(name)):\n${findings.join('\n')}`,
    );
}
