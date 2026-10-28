// Biomes goal G1 on R16 in Node: ms per km2 for each CPU stage (bench/biomes/placement.mjs).
import { ms, nodeCase } from '../lib/node.mjs';

export default {
  name: 'biomes',
  title: 'Biome maps on the reference world R16: CPU ms per km2 per stage (Node)',
  uses: 'cpu',
  async cases() {
    const { stages, TILE } = await import('../biomes/placement.mjs');
    const perKm2 = 1e6 / (TILE.size * TILE.size);
    return (await stages()).map((stage) =>
      nodeCase(stage.id, stage.title, { msPerKm2: ms() }, () => {
        const start = performance.now();
        stage.run();
        return { msPerKm2: (performance.now() - start) * perKm2 };
      }),
    );
  },
};
