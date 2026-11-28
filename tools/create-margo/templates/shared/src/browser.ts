const HELP = 'https://github.com/scottcampbelldata/margoengine#browser-support';

export const NO_WEBGPU = 'This browser has no WebGPU, so this starter cannot draw. Open it in current Chrome or Edge.';

export async function hasWebGPU(): Promise<boolean> {
  return 'gpu' in navigator && (await navigator.gpu.requestAdapter()) !== null;
}

/** A light full-page note, with a link, instead of a dark canvas and a one-line error. */
export function showStartError(message: string) {
  const node = document.querySelector('#error') ?? document.querySelector('#root');
  if (!(node instanceof HTMLElement)) return;
  node.hidden = false;
  node.replaceChildren();
  const text = document.createElement('span');
  text.textContent = message;
  const link = document.createElement('a');
  link.href = HELP;
  link.textContent = 'Browsers that run Margo';
  node.append(text, link);
}
