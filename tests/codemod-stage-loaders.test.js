import test from 'node:test';
import assert from 'node:assert/strict';
import { rewriteCode, rewriteMarkdown } from '../scripts/codemod-stage-loaders.mjs';

test('codemod rewrites every former Stage method into its feature entry and is idempotent', () => {
  const source = [
    "import { createStage } from 'margoengine';",
    '',
    "const app = await createStage('#scene');",
    "const model = await app.load('./model.glb', { fit: false });",
    "const scene = await app.load('/scene.GLB?v=2');",
    "const mesh = await app.load(url, { format: 'gltf' });",
    'const sky = await app.sky();',
    'const sparks = await app.particles({ count: 32 });',
    'const fx = await app.effects({ grain: 0.01 });',
    "const light = await app.environment('/studio.hdr', { intensity: 2 });",
    'const shadows = await app.shadows({ resolution: 1024 });',
    'const { Scenery } = (await app.scenery()) as typeof import("margoengine/scenery");',
    '// A comment that mentions app.sky() is left alone.',
    "engine.environment('x');",
    '',
  ].join('\n');
  const { text, problems } = rewriteCode(source);
  assert.deepEqual(problems, []);
  for (const line of [
    "import { addGLTF } from 'margoengine/stage/gltf';",
    "import { addShadows } from 'margoengine/stage/shadows';",
    "const model = await addGLTF(app, './model.glb', { fit: false });",
    "const scene = await addGLTF(app, '/scene.GLB?v=2');",
    'const mesh = await addGLTF(app, url);',
    'const sky = await addSky(app);',
    'const sparks = await addParticles(app, { count: 32 });',
    'const fx = await addEffects(app, { grain: 0.01 });',
    "const light = await addEnvironment(app, '/studio.hdr', { intensity: 2 });",
    'const shadows = await addShadows(app, { resolution: 1024 });',
    "const { Scenery } = await import('margoengine/scenery');",
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
  // A format the stage has no feature entry for (OBJ, STL, ...) is listed for a hand rewrite, by extension or option.
  for (const call of ["await app.load('/part.obj');", "await app.load('/scene.glb', { format: 'stl' });"]) {
    const other = rewriteCode(`import { createStage } from 'margoengine';\n${call}\n`);
    assert.equal(other.problems.length, 1, call);
    assert.ok(other.text.includes(call), call);
    assert.doesNotMatch(other.text, /margoengine\/stage\//, call);
  }
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
    "const model = await app.load('/assembly.glb');",
    '```',
    '',
  ].join('\n');
  const { text, problems, prose } = rewriteMarkdown(markdown);
  assert.deepEqual(problems, []);
  assert.equal(prose.length, 1);
  assert.match(
    text,
    /import \{createStage\} from 'margoengine';\nimport \{ addGLTF \} from 'margoengine\/stage\/gltf';/,
  );
  assert.match(text, /const model = await addGLTF\(app, '\/assembly\.glb'\);/);
  assert.equal(rewriteMarkdown(text).text, text);
});
