// An entry a worker bundle never calls: a biome world worker is made without a GPU device, so the GPU kernels entry
// (@margoengine/biomes/gpu, loaded only by a world with a device) is left out of the worker file; so are the digest
// entry (no worker job makes a digest) and the presets (the page sends its world's biomes, so the replica never needs
// the default ones).
export {};
