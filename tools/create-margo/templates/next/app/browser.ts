export const NO_WEBGPU =
  'This browser has no WebGPU, so this starter cannot draw. Open it in current Chrome or Edge.';

export const BROWSER_HELP = 'https://github.com/scottcampbelldata/margoengine#browser-support';

export async function hasWebGPU(): Promise<boolean> {
  return 'gpu' in navigator && (await navigator.gpu.requestAdapter()) !== null;
}
