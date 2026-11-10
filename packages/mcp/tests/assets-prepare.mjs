// CPU/network preparation. Run before taking a GPU slot; all real CC0 data stays in ignored test-results.
import { writeFile, mkdir } from 'node:fs/promises';
import { AssetLibrary } from '../dist/assets.js';
const root = 'test-results/mcp-assets-proof';
await mkdir(root, { recursive: true });
const library = new AssetLibrary({ directory: root });
const fixtures = [];
for (const [provider, kind, query, variant] of [
  ['khronos', 'model', 'Triangle', 'glTF'],
  ['polyhaven', 'model', 'wooden table 02', 'gltf/1k/gltf'],
  ['polyhaven', 'hdri', 'venice sunset', 'hdri/1k/hdr'],
  ['polyhaven', 'texture', 'aerial rocks 04', 'Diffuse/1k/jpg'],
  ['ambientcg', 'texture', 'bricks', '1K-JPG'],
]) {
  const [asset] = await library.search({ provider, kind, query, limit: 1 });
  if (!asset) throw new TypeError(`No real ${provider} ${kind} fixture; inspect provider metadata`);
  const download = await library.download(`${provider}:${asset.id}`, variant);
  fixtures.push(download);
  console.log(`${provider} ${asset.id} ${variant}: ${download.files.length} files, ${asset.license}`);
}
await writeFile(`${root}/fixtures.json`, JSON.stringify(fixtures, null, 2));
