import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

// Every optional hook (directional, IES, projector, shapes, stochastic, cube cookies, area textures, the shadow atlas,
// layers ...) joins its entries into the one lit-shader bind group (Clustered.bindings), so two modules declaring the
// same hook binding make a duplicate binding when both are attached. Hook bindings are 100 and up; the lower numbers
// are the cluster's own and shadow resources, shared on purpose between the modules that build them.
// Regression: stochastic.ts (6d64a8732) and cube-projector.ts (4ea50d1f7) both declared binding 151.
test('no two clustered modules declare the same lit-group hook binding', () => {
  const dir = new URL('../src/', import.meta.url),
    owners = new Map();
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.ts'))) {
    const source = readFileSync(new URL(name, dir), 'utf8');
    for (const match of source.matchAll(/BINDING\s*=\s*(\d+)|@binding\((\d+)\)|binding:\s*(\d+)/g)) {
      const binding = Number(match[1] ?? match[2] ?? match[3]);
      if (binding < 100) continue;
      const files = owners.get(binding) ?? new Set();
      files.add(name);
      owners.set(binding, files);
    }
  }
  assert.ok(owners.size >= 5, `found only ${owners.size} hook bindings; the scan no longer matches the sources`);
  const shared = [...owners]
    .filter(([, files]) => files.size > 1)
    .map(([binding, files]) => `${binding}: ${[...files].join(', ')}`);
  assert.deepEqual(shared, []);
});
