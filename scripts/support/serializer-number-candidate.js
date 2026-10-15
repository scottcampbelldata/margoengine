import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// data: URL modules cannot resolve bare specifiers, so point the ones the exporter sources use at the built files.
const resolveBare = (code) =>
  code
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
  const before =
    '    const text = f.toPrecision(digits);\n    if (Math.fround(Number(text)) === f) return String(Number(text));';
  assert.equal(original.split(before).length, 2, 'Exporter number-format source changed before comparison');
  return {
    original,
    candidate: original.replace(
      before,
      '    const text = Number(f.toPrecision(digits));\n    if (Math.fround(text) === f) return String(text);',
    ),
  };
}

export async function importSerializerNumberSource(source) {
  const code = resolveBare(stripTypeScriptTypes(source, { mode: 'transform' }));
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
}

/** Import every actual serializer with just the shared scene/number module replaced. */
export async function importExporterNumberSource(source) {
  const sceneCode = resolveBare(stripTypeScriptTypes(source, { mode: 'transform' }));
  const sceneURL = 'data:text/javascript;base64,' + Buffer.from(sceneCode).toString('base64'),
    modules = [];
  for (const file of ['gltf', 'stl', 'obj', 'ply', 'usdz']) {
    const code = resolveBare(
      stripTypeScriptTypes(await readFile(`packages/exporters/src/${file}.ts`, 'utf8'), { mode: 'transform' }),
    ).replaceAll("'./scene.js'", JSON.stringify(sceneURL));
    modules.push(await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64')));
  }
  return Object.assign({}, ...modules);
}
