// Writes layout.json, the dimensions build_orrery.py reads, from examples/orrery/layout.ts (the one source of them).
// Run: node examples/orrery/blender/write-layout.mjs
import { writeFileSync } from 'node:fs';
import { layoutJSON } from './layout-json.mjs';

writeFileSync(new URL('./layout.json', import.meta.url), layoutJSON());
console.log('wrote examples/orrery/blender/layout.json');
