// Build-time declarations, frozen into each package's emitted JavaScript. No loader hooks or import-time registry.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSync } from 'rolldown/utils';

const marker = '// @margo/core-built ';
const key = (node) => node?.key?.name ?? node?.key?.value;
const method = (node) => node.type === 'MethodDefinition';

/** Stamp attachment boundaries and plugin declarations, including aliases in minified package output. */
export function declareCoreRequirement(code, version, filename = 'package.js') {
  if (code.startsWith(marker)) return code;
  const parsed = parseSync(filename, code);
  assert.equal(parsed.errors.length, 0, `Cannot declare core requirement in ${filename}`);
  // Classic workers are Script programs, not module attachment boundaries. An ESM import would break them.
  if (parsed.program.sourceType === 'script') return code;
  const edits = [], wrappers = [];
  const used = new Set();
  const fresh = (prefix) => {
    let name = prefix, serial = 0;
    while (code.includes(name) || used.has(name)) name = prefix + ++serial;
    used.add(name);
    return name;
  };
  const core = fresh('__margoCoreRequirement'), check = fresh('__margoAssertCore');
  for (const node of parsed.program.body) {
    if (node.type !== 'ImportDeclaration' || node.source.value !== '@margoengine/core/extension') continue;
    for (const specifier of node.specifiers) {
      if (specifier.imported?.name !== 'engineRuntime') continue;
      const imported = fresh('__margoRuntime');
      edits.push({ at: specifier.start, end: specifier.end, text: `engineRuntime as ${imported}` });
      // Preserve the original lexical binding. Local shadows, aliases and callbacks need no call-site rewriting.
      wrappers.push(`const ${specifier.local.name}=(engine,version=${JSON.stringify(version)},source=import.meta.url)=>${imported}(engine,version,source);`);
    }
  }
  const requirement = `${core}(${JSON.stringify(version)},import.meta.url)`;
  const insert = (at, text) => edits.push({ at, text });
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (['ClassDeclaration', 'ClassExpression'].includes(node.type)) {
      if (node.body.body.some((member) => method(member) && !member.static && key(member) === 'setup') &&
          !node.body.body.some((member) => key(member) === 'coreRequirement')) {
        insert(node.body.start + 1, `coreRequirement=${requirement};`);
      }
    }
    if (node.type === 'ObjectExpression') {
      if (node.properties.some((member) => key(member) === 'setup') && node.properties.some((member) => key(member) === 'name') &&
          !node.properties.some((member) => key(member) === 'coreRequirement')) {
        insert(node.start + 1, `coreRequirement:/*@__PURE__*/${requirement},`);
      }
    }
    if (method(node) && node.static && key(node) === 'attach') {
      const engine = node.value.params[0];
      if (engine?.type === 'Identifier') insert(node.value.body.start + 1, `${check}(${engine.name},${requirement});`);
    }
    for (const [name, value] of Object.entries(node)) {
      if (name === 'comments') continue;
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  }
  walk(parsed.program);
  if (!edits.length) return code;
  edits.sort((a, b) => b.at - a.at);
  for (const { at, end = at, text } of edits) code = code.slice(0, at) + text + code.slice(end);
  return `${marker}${version}\nimport {coreRequirement as ${core},assertCore as ${check}} from '@margoengine/core/extension';\n${wrappers.join('\n')}\n${code}`;
}

/** Apply after emission, so custom and TypeScript builds publish the same exact-version declarations. */
export async function declarePackageCore(root) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const version = JSON.parse(await readFile(new URL('../packages/core/package.json', import.meta.url), 'utf8')).version;
  const source = await readFile(new URL('../packages/core/src/version.ts', import.meta.url), 'utf8');
  assert.equal(/CORE_VERSION = '([^']+)'/.exec(source)?.[1], version, 'CORE_VERSION must match the core manifest');
  if (manifest.name === '@margoengine/core') return;
  if (!{ ...manifest.dependencies, ...manifest.peerDependencies }['@margoengine/core']) return;
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith('.js')) {
        const code = await readFile(path, 'utf8');
        const output = declareCoreRequirement(code, version, path);
        if (output !== code) await writeFile(path, output);
      }
    }
  }
  await visit(join(root, 'dist'));
}
