import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';

test('sandbox consumes package distributions and keeps engine algorithms in shared modules', async () => {
  const root = new URL('../',import.meta.url), source = new URL('src/',root);
  for (const path of await readdir(source,{recursive:true})) {
    if (!path.endsWith('.ts')) continue;
    const text = await readFile(new URL(path.replaceAll('\\','/'),source),'utf8');
    assert.doesNotMatch(text,/new (?:Geometry|Noise)\b|function (?:generate\w+|terrainHeight|terrainData)\b|\.create(?:Texture|Buffer|ShaderModule)\(|onDeviceRestored|Math\.(?:sin|cos|exp|hypot)\(/,path+' contains an engine implementation');
    assert.doesNotMatch(text,/from\s+['"][^'"]*packages\//,path+' bypasses a public package export');
  }
  const vite = await readFile(new URL('vite.config.ts',root),'utf8'), config = JSON.parse(await readFile(new URL('tsconfig.json',root),'utf8'));
  assert.doesNotMatch(vite,/alias|packages\/.*src/); assert.equal(config.compilerOptions.paths,undefined);
});
