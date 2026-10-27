import test from 'node:test';
import assert from 'node:assert/strict';
import { rewriteCode, rewriteMarkdown } from '../scripts/codemod-stage-loaders.mjs';

test('codemod rewrites every former Stage method into its feature entry and is idempotent', () => {
  const source = [
    "import { createStage } from 'margoengine';",
    '',
    "const app = await createStage('#scene');",
    "const model = await app.load('./model.glb', { fit: false });",
    "const part = await app.load('/bracket.STEP?v=2');",
    "const mesh = await app.load(url, { format: 'obj' });",
    'const sky = await app.sky();',
    'const sparks = await app.particles({ count: 32 });',
    'const fx = await app.effects({ grain: 0.01 });',
    "const light = await app.environment('/studio.hdr', { intensity: 2 });",
    'const shadows = await app.shadows({ resolution: 1024 });',
    'const { AssemblyIndex } = (await app.machinery()) as typeof import("margoengine/machinery");',
    '// A comment that mentions app.sky() is left alone.',
    "engine.environment('x');",
    '',
  ].join('\n');
  const { text, problems } = rewriteCode(source);
  assert.deepEqual(problems, []);
  for (const line of [
    "import { addGLTF } from 'margoengine/stage/gltf';",
    "import { addCAD } from 'margoengine/stage/cad';",
    "import { addShadows } from 'margoengine/stage/shadows';",
    "const model = await addGLTF(app, './model.glb', { fit: false });",
    "const part = await addCAD(app, '/bracket.STEP?v=2');",
    "const mesh = await addCAD(app, url, { format: 'obj' });",
    'const sky = await addSky(app);',
    'const sparks = await addParticles(app, { count: 32 });',
    'const fx = await addEffects(app, { grain: 0.01 });',
    "const light = await addEnvironment(app, '/studio.hdr', { intensity: 2 });",
    'const shadows = await addShadows(app, { resolution: 1024 });',
    "const { AssemblyIndex } = await import('margoengine/machinery');",
    '// A comment that mentions app.sky() is left alone.',
    "engine.environment('x');",
  ])
    assert.ok(text.includes(line), line);
  assert.equal(rewriteCode(text).text, text, 'a second run changes nothing');
});

test('codemod reports what it cannot rewrite instead of guessing', () => {
  const { text, problems } = rewriteCode("import { Stage } from '@margoengine/stage';\nawait stage.load(url);\n");
  assert.equal(problems.length, 1);
  assert.match(text, /stage\.load\(url\)/);
  const browser = rewriteCode(
    "import x from 'node:fs';\nawait page.evaluate(async () => { await window.app.sky(); });\n",
  );
  assert.match(browser.problems[0].call, /template string|inside/);
  assert.doesNotMatch(browser.text, /import \{ addSky \}/, 'no static import for code that runs in the page');
});

test('codemod puts a continuation fence its imports in the setup fence before it', () => {
  const markdown = [
    '```ts',
    "import {createStage} from 'margoengine';",
    "const app = await createStage('#scene');",
    '```',
    '',
    'Then `app.load()` in prose stays.',
    '',
    '```ts',
    "const model = await app.load('/assembly.obj');",
    '```',
    '',
  ].join('\n');
  const { text, problems, prose } = rewriteMarkdown(markdown);
  assert.deepEqual(problems, []);
  assert.equal(prose.length, 1);
  assert.match(text, /import \{createStage\} from 'margoengine';\nimport \{ addCAD \} from 'margoengine\/stage\/cad';/);
  assert.match(text, /const model = await addCAD\(app, '\/assembly\.obj'\);/);
  assert.equal(rewriteMarkdown(text).text, text);
});
