import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', root)));
const versions = { [manifest.name]: manifest.version };
function include(current) {
  for (const name of Object.keys({ ...current.dependencies, ...current.peerDependencies })) {
    if (!name.startsWith('@margoengine/') || Object.hasOwn(versions, name)) continue;
    const sibling = new URL('../' + name.slice('@margoengine/'.length) + '/package.json', root);
    const dependency = JSON.parse(readFileSync(sibling));
    versions[name] = dependency.version;
    include(dependency);
  }
}
include(manifest);
const output = new URL('src/provenance-versions.ts', root);
const source =
  '// Generated from workspace package manifests by scripts/write-provenance-versions.mjs.\n' +
  '/** @internal Exact versions resolved at package build time. */\nexport const packageVersions: Readonly<Record<string, string>> = ' +
  JSON.stringify(versions, null, 2) +
  ';\n';
if (!existsSync(output) || readFileSync(output, 'utf8').replace(/\r\n/g, '\n') !== source) writeFileSync(output, source);
