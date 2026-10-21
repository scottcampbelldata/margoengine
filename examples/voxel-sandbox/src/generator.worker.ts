// The sandbox's world generator, a module worker that VoxelStreamer starts by URL: src/plants.ts. The seed comes in the
// worker URL (?seed=).
import { serveVoxelGenerator } from '@margoengine/voxel/generate';
import { sandboxGenerator } from './plants.ts';
import { DEFAULT_SEED } from './terrain.ts';

serveVoxelGenerator(sandboxGenerator(Number(new URL(self.location.href).searchParams.get('seed') ?? DEFAULT_SEED) | 0));
