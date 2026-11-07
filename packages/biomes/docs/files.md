# @margoengine/biomes: Files in and out

Heightmaps, weight maps, biome masks, layer dumps and saved worlds (`/io`). One of the package guides; the [README](../README.md) has the quickstart and the list of guides.

## Files in and out

`@margoengine/biomes/io` writes a world for other tools and saves it for yourself. It is its own entry: the root does not
import it, and `BiomeWorld` never loads it. The PNG writer is in the package (stored blocks by default, or
`compress: true` through `CompressionStream`), with no other code behind it and no dependency.

```js
import { BiomeWorld } from '@margoengine/biomes';
import { exportHeight, exportWeights, exportMasks, exportLayer, saveWorld, loadWorld } from '@margoengine/biomes/io';

const world = await BiomeWorld.create();
const height = await exportHeight(world, 'png16'); // or 'raw16' (little-endian) or 'f32' (metres)
// height.data is the file; height.min and height.max (metres) map to 0 and 65535 in the 16-bit files
const { biomes, planes, splats } = await exportWeights(world); // one 0..255 plane per biome; RGBA PNGs of four biomes each
const masks = await exportMasks(world); // Map of biome id to a grayscale PNG
const csv = await exportLayer(world, 'temperature', 'csv'); // or 'json'; the stored integers, `value * scale` is in `unit`
```

Every export takes `{ tiles: [x0, z0, x1, z1], compress, signal }`: a rectangle of tile indices (default the whole world).
The 16-bit mapping is integer maths, so the same world gives the same file on every machine.

Saving a world keeps its options and every painted and masked layer; it does not keep the cache or runtime options (device,
workers). A `field` height function cannot be saved, and `saveWorld` says so.

```js
const text = JSON.stringify(saveWorld(world));
const copy = await loadWorld(text, { workers: false }); // runtime options go in the second argument
console.log((await copy.digest(0, 0)) === (await world.digest(0, 0))); // true
```
