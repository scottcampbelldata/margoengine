// Voxels: world fill, chunk meshing and voxel raycasts in Node (@margoengine/voxel), then the voxel sandbox in the
// browser (examples/voxel-sandbox/bench.mjs at render distance 8: spawn time, frame CPU, voxel GPU passes, a 10 s
// flight while chunks stream in). One sandbox sample is one fresh run of that script.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { root } from '../lib/env.mjs';
import { median, ms, nodeCase, timed } from '../lib/node.mjs';

const voxel = (sub = 'index') => import(`../../packages/voxel/dist/${sub}.js`);

/**
 * A 256 x 64 x 256 rolling terrain (stone under grass) in 8 x 2 x 8 chunks. `shaped`: every surface cell one block
 * up gets a slab or stair on a fixed pattern (a third each of air, slabs and stairs of every facing). `mixed`: a third
 * of those cells water, the rest double slabs, waterlogged slabs, inner and outer corner stairs and waterlogged stairs.
 */
async function terrain(shaped = false, mixed = false) {
  const { BlockTypes, VoxelWorld, doubleSlabState, slabState, stairState, waterlogState } = await voxel(),
    blocks = new BlockTypes(),
    stone = blocks.define('stone'),
    grass = blocks.define('grass'),
    water = blocks.define('water', { shape: 'liquid', liquid: true, solid: false, layer: 'translucent' }),
    slab = blocks.define('slab', { shape: 'slab', waterlog: water }),
    stair = blocks.define('stair', { shape: 'stair', waterlog: water }),
    across = { '+x': '+z', '-x': '-z', '+z': '-x', '-z': '+x' },
    facings = ['+x', '-x', '+z', '-z'],
    world = new VoxelWorld({ blocks }),
    cells = [];
  for (let x = 0; x < 256; x++)
    for (let z = 0; z < 256; z++) {
      const h = Math.floor(24 + 10 * Math.sin(x * 0.05) * Math.cos(z * 0.04) + 6 * Math.sin((x + z) * 0.11));
      for (let y = 0; y <= h; y++) cells.push(x, y, z, y === h ? grass : stone);
      const k = (x * 7 + z * 13) % 9,
        facing = facings[(x + z) & 3];
      if (mixed)
        cells.push(
          x,
          h + 1,
          z,
          [
            water,
            water,
            water,
            doubleSlabState(slab),
            waterlogState(slabState(slab)),
            waterlogState(slabState(slab, true)),
            waterlogState(stairState(stair, facing, false, `inner${across[facing]}`)),
            stairState(stair, facing, false, `outer${across[facing]}`),
            waterlogState(stairState(stair, facing, true)),
          ][k],
        );
      else if (shaped && k >= 3)
        cells.push(x, h + 1, z, k < 6 ? slabState(slab, k === 5) : stairState(stair, facing, k === 8));
    }
  world.setBlocks(cells);
  return world;
}

export default {
  name: 'voxel',
  title: 'Voxel fill, meshing, raycasts (Node) and the voxel sandbox (browser)',
  uses: 'gpu',
  async cases(ctx) {
    const state = {};
    return [
      nodeCase(
        'fill-256x64x256',
        'Fill a 256 x 64 x 256 terrain (8 x 2 x 8 chunks) with setBlocks',
        { fillMs: ms() },
        async () => {
          const t = [];
          for (let i = 0; i < 3; i++) {
            const s = performance.now();
            state.world = await terrain();
            t.push(performance.now() - s);
          }
          return { fillMs: median(t) };
        },
      ),
      nodeCase(
        'mesh-128-chunks',
        'Mesh all 128 chunks of that terrain (meshChunk, greedy quads)',
        { meshMs: ms(), quads: { unit: '', exact: true } },
        async () => {
          const { meshChunk, meshInput } = await voxel('mesher');
          state.world ??= await terrain();
          const keys = [...state.world.dirty];
          let quads = 0;
          const meshMs = timed(
            () => {
              quads = 0;
              for (const key of keys) {
                const input = meshInput(state.world, key);
                if (!input) continue;
                const m = meshChunk(input);
                quads += (m.opaque.length + m.cutout.length + m.translucent.length) / 3; // 3 words per quad
              }
            },
            { reps: 5, warm: 1 },
          );
          return { meshMs, quads };
        },
      ),
      nodeCase(
        'mesh-128-shaped-chunks',
        'Mesh the same terrain with slabs and stairs on two thirds of its surface (half-block faces, greedy quads)',
        { meshMs: ms(), quads: { unit: '', exact: true } },
        async () => {
          const { meshChunk, meshInput } = await voxel('mesher'),
            world = await terrain(true),
            keys = [...world.dirty];
          let quads = 0;
          const meshMs = timed(
            () => {
              quads = 0;
              for (const key of keys) {
                const input = meshInput(world, key);
                if (!input) continue;
                const m = meshChunk(input);
                quads += (m.opaque.length + m.cutout.length + m.translucent.length) / 3;
              }
            },
            { reps: 5, warm: 1 },
          );
          return { meshMs, quads };
        },
      ),
      nodeCase(
        'mesh-128-mixed-shape-chunks',
        'Mesh the terrain with water, double slabs, waterlogged slabs and stairs and corner stairs on its surface',
        { meshMs: ms(), quads: { unit: '', exact: true } },
        async () => {
          const { meshChunk, meshInput } = await voxel('mesher'),
            world = await terrain(false, true),
            keys = [...world.dirty];
          let quads = 0;
          const meshMs = timed(
            () => {
              quads = 0;
              for (const key of keys) {
                const input = meshInput(world, key);
                if (!input) continue;
                const m = meshChunk(input);
                quads += (m.opaque.length + m.cutout.length + m.translucent.length) / 3;
              }
            },
            { reps: 5, warm: 1 },
          );
          return { meshMs, quads };
        },
      ),
      nodeCase(
        'raycast-10k',
        '10,000 voxel raycasts of up to 64 blocks into that terrain',
        { raysMs: ms() },
        async () => {
          const { raycastVoxels } = await voxel('query');
          state.world ??= await terrain();
          return {
            raysMs: timed(
              () => {
                for (let i = 0; i < 10_000; i++)
                  raycastVoxels(state.world, [(i * 7) % 256, 60, (i * 13) % 256], [0.3, -0.8, 0.5], 64);
              },
              { reps: 9 },
            ),
          };
        },
        { teardown: async () => delete state.world },
      ),
      {
        id: 'sandbox-rd8',
        title: 'Voxel sandbox at render distance 8, 1920 x 1080, 4x MSAA (examples/voxel-sandbox/bench.mjs)',
        runs: Math.min(ctx.options.runs, 3),
        warmup: 0,
        metrics: {
          spawnMs: ms(),
          frameCpuMs: ms(),
          voxelGpuMs: ms(),
          flightFrameCpuP95Ms: ms(false),
          quads: { unit: '', exact: true },
          draws: { unit: '', exact: true },
        },
        async run() {
          // The gate already ran and this process holds the GPU lock (MARGO_GPU_LOCK_NESTED lets the script in).
          execFileSync(
            process.execPath,
            ['examples/voxel-sandbox/bench.mjs', '--no-quiet', '--distances=8', '--loads=1'],
            {
              cwd: root,
              stdio: ['ignore', 'ignore', 'inherit'],
            },
          );
          const report = JSON.parse(readFileSync(resolve(root, 'test-results/voxel-sandbox-bench.json'), 'utf8')),
            row = report.results[0];
          return {
            values: {
              spawnMs: row.spawnMs,
              frameCpuMs: row.frameCpuMs.median,
              voxelGpuMs: row.voxelGpuMs?.median,
              flightFrameCpuP95Ms: row.flight.frameCpuMs.p95,
              quads: row.quads,
              draws: row.draws,
            },
            info: { hardware: report.hardware, browser: report.browser, errors: report.errors?.slice(0, 5) },
          };
        },
      },
    ];
  },
};
