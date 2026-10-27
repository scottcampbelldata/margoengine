import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SUBPATHS, rewriteCode, rewriteMarkdown } from '../scripts/codemod-react-subpaths.mjs';

test('codemod moves each binding to the subpath named after its package, and is idempotent', () => {
  const source = [
    "import { Canvas, Mesh, OrbitControls, Gltf, type GltfProps } from '@margoengine/react';",
    "import { Box, Html } from '@margoengine/react/kit';",
    "import { EffectComposer, Bloom, DepthOfField } from '@margoengine/react/post';",
    "void preload('/a.glb');",
    "void preload('/studio.hdr');",
    '',
  ].join('\n');
  const { text, problems } = rewriteCode(source);
  assert.deepEqual(problems, []);
  for (const line of [
    "import { Canvas, Mesh } from '@margoengine/react';",
    "import { OrbitControls } from '@margoengine/react/controls';",
    "import { Gltf, type GltfProps } from '@margoengine/react/gltf-pro';",
    "import { Box } from '@margoengine/react/geometry';",
    "import { Html } from '@margoengine/react/html';",
    "import { EffectComposer, Bloom } from '@margoengine/react/post';",
    "import { DepthOfField } from '@margoengine/react/dof';",
    "void Gltf.preload('/a.glb');",
    "void Environment.preload('/studio.hdr');",
    "import { Environment } from '@margoengine/react/environment';",
  ])
    assert.ok(text.includes(line), line);
  assert.equal(rewriteCode(text).text, text);
});

test('codemod lists what it cannot rewrite', () => {
  const { problems } = rewriteCode(
    "import { Canvas, preload } from '@margoengine/react';\nexport const all = [preload];\nconst a = <Canvas shadows />;\n",
  );
  assert.equal(problems.length, 2);
  assert.match(rewriteMarkdown("```tsx\nimport { Sky } from '@margoengine/react';\n```\n").text, /react\/sky/);
});

test('every subpath the codemod names is an entry of the package', () => {
  const exports = JSON.parse(readFileSync(new URL('../packages/react/package.json', import.meta.url), 'utf8')).exports;
  for (const subpath of Object.keys(SUBPATHS)) assert.ok(exports[`./${subpath}`], subpath);
});
