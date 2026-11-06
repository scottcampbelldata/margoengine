// A plugin class names one EnginePlugin: the one its setup() takes. @margoengine/core has the EngineKernel one and
// @margoengine/core/extension the Engine one. Mixing them compiles in the repository, whose packages set skipLibCheck,
// and fails in the published .d.ts for any app with skipLibCheck off (scripts/publish-rehearsal.mjs found three).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const packages = join(import.meta.dirname, '..', 'packages');

/** Source files under a package's src folder. */
const sources = (name) =>
  readdirSync(join(packages, name, 'src'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));

/** Does this source import EnginePlugin from @margoengine/core/extension? */
const takesExtensionPlugin = (code) =>
  [...code.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'@margoengine\/core\/extension'/g)].some((match) =>
    /\bEnginePlugin\b/.test(match[1]),
  );

test('the check sees an EnginePlugin imported from the extension entry, in either import form', () => {
  assert.ok(takesExtensionPlugin("import type { EnginePlugin } from '@margoengine/core/extension';"));
  assert.ok(takesExtensionPlugin("import {\n  engineRuntime,\n  type EnginePlugin,\n} from '@margoengine/core/extension';"));
  assert.ok(!takesExtensionPlugin("import type { EnginePlugin } from '@margoengine/core';"));
});

test('a plugin whose setup takes an EngineKernel implements the EngineKernel EnginePlugin', () => {
  const wrong = [];
  for (const name of readdirSync(packages)) {
    if (name === 'core' || !readdirSync(join(packages, name)).includes('src')) continue;
    for (const file of sources(name)) {
      const code = readFileSync(file, 'utf8');
      if (/\bsetup\(engine: EngineKernel\b/.test(code) && /implements [^{]*\bEnginePlugin\b/.test(code) && takesExtensionPlugin(code))
        wrong.push(file);
    }
  }
  assert.deepEqual(wrong, []);
});
