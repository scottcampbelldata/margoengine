import { moduleHooks } from '../../../scripts/support/node-compat.mjs';
const source = (name) => new URL(`../src/${name}.ts`, import.meta.url).href;
await moduleHooks([
  ...['toolkit', 'region', 'relief', 'presets', 'digest', 'gpu'].map((name) => ({
    specifier: `@margoengine/biomes/${name}`,
    url: source(name),
  })),
  { source: new URL('../../../', import.meta.url).href },
  { lower: true },
]);
