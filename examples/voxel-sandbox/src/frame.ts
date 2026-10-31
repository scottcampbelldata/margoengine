// Small pure pieces of the frame loop and the HUD, kept apart from main.ts so they can be tested without a page.

/**
 * Seconds a frame steps, from two requestAnimationFrame times (0 for the first). Limited to the 0.25 s VoxelCharacter and
 * VoxelNetClient simulate in one update: a lower limit here takes walking time away from a slow machine (at 0.1 s,
 * everything under 10 FPS walked slower than it should). A background tab does not need it: the page restarts the clock.
 */
export function frameSeconds(time: number, last: number): number {
  return last ? Math.min((time - last) / 1000, 0.25) : 0;
}

/**
 * The HUD's chunk line. `chunks` are the chunks with quads held on the GPU, and only `visible` of them are in the camera
 * frustum and drawn by the main pass (the shadow passes cull by their own cascades), so `chunks` is not "drawn".
 */
export function chunkLine(stats: { chunks: number; visible: number }, loaded: number, state: string): string {
  return `chunks ${stats.chunks} meshed, ${stats.visible} visible, ${loaded} loaded, ${state}`;
}
