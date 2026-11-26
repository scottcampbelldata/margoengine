// Shared by the from-PlayCanvas examples: the status line, and a clear message when WebGPU is missing.
export const status = document.querySelector<HTMLElement>('#status')!;

export function fail(error: Error): never {
  status.textContent = `Margo could not start: ${error.message}. These examples need a browser with WebGPU.`;
  throw error;
}
