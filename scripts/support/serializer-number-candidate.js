import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// data: URL modules cannot resolve bare specifiers, so point the ones the exporter sources use at the built files.
const resolveBare = (code) =>
  code
    .replace(/'\.\.\/\.\.\/shared\/([^']+)'/g, (_, file) => JSON.stringify(pathToFileURL(resolve('packages/shared', file)).href))
    .replaceAll(
      "'@margoengine/core/extension'",
      JSON.stringify(pathToFileURL(resolve('packages/core/dist/extension.js')).href),
    )
    .replace(/'@margoengine\/math\/(\w+)'/g, (_, entry) =>
      JSON.stringify(pathToFileURL(resolve(`packages/math/dist/${entry}.js`)).href),
    );

/** Keeps the exact shortest-Float32 decimal search while converting its winning string once. */
export async function serializerNumberSources() {
  const original = (await readFile('packages/exporters/src/scene.ts', 'utf8')).replace(/\r\n/g, '\n');
  const pattern = /const text\s*=\s*f\.toPrecision\(digits\);\s*if\s*\(Math\.fround\(Number\(text\)\)\s*===\s*f\)\s*return String\(Number\(text\)\);/g;
  const matches = [...original.matchAll(pattern)];
  assert.equal(matches.length, 1, 'Exporter number-format source changed before comparison');
  const before = matches[0][0];
  return {
    original,
    candidate: original.replace(
      before,
      '    const text = Number(f.toPrecision(digits));\n    if (Math.fround(text) === f) return String(text);',
    ),
  };
}

export async function importSerializerNumberSource(source) {
  const code = resolveBare(stripTypeScriptTypes(source, { mode: 'strip' }));
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
}

/** Import every actual serializer with just the shared scene/number module replaced. */
export async function importExporterNumberSource(source) {
  const sceneCode = resolveBare(stripTypeScriptTypes(source, { mode: 'strip' }));
  const sceneURL = 'data:text/javascript;base64,' + Buffer.from(sceneCode).toString('base64'),
    modules = [];
  for (const file of ['gltf', 'stl', 'obj', 'ply', 'usdz']) {
    const code = resolveBare(
      stripTypeScriptTypes(await readFile(`packages/exporters/src/${file}.ts`, 'utf8'), { mode: 'strip' }),
    ).replaceAll("'./scene.js'", JSON.stringify(sceneURL));
    modules.push(await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64')));
  }
  return Object.assign({}, ...modules);
}
