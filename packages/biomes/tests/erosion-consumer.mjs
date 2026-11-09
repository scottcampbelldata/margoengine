import { build } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

export const consumerRoot = resolve(import.meta.dirname, '../../../test-results/biomes-erosion-consumer');

// CPU preparation, deliberately outside the browser suite's GPU lease.
export async function buildErosionConsumer() {
  mkdirSync(consumerRoot, { recursive: true });
  writeFileSync(join(consumerRoot, 'index.html'), '<canvas></canvas><script type="module" src="/main.js"></script>');
  writeFileSync(
    join(consumerRoot, 'main.js'),
    `import {createErosionKernel} from '@margoengine/biomes/erosion-wasm';
window.runErosion=async(grid)=>{const kernel=await createErosionKernel();try {const a=kernel.erode({...grid,height:Int32Array.from(grid.height)});return {height:[...a.height],flow:[...a.flow],direction:[...a.direction],wear:[...a.wear],deposit:[...a.deposit],outflow:a.outflow,blocks:a.vectorBlocks};}finally{kernel.dispose();}};`,
  );
  await build({
    root: consumerRoot,
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
    build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  });
}
