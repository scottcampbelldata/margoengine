// Loaded only when the quickstart cannot start. createStage (through Engine.create) rejects with
// Error('WebGPU unavailable') when no WebGPU renderer can be made, or with the renderer's Error('adapter unavailable')
// for backend 'webgpu'. Those two get a visible message that names the failure; every error, those two included, is
// thrown on unchanged.
export function explainWebGPUFailure(error: unknown, message: string, scene: string): never {
  if (error instanceof Error && (error.message === 'WebGPU unavailable' || error.message === 'adapter unavailable')) {
    const failure = (navigator as Navigator & { gpu?: unknown }).gpu
      ? `WebGPU could not start (${error.message})`
      : 'WebGPU is missing';
    const element = document.querySelector<HTMLElement>(message);
    if (element) {
      element.textContent = `${failure}: this browser cannot open the view.`;
      document.querySelector<HTMLElement>(scene)?.setAttribute('hidden', '');
    }
  }
  throw error;
}
