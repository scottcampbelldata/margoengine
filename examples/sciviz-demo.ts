// Small helpers shared by the real-data demos. Data and plotting stay in each page's source.
import type { Figure } from '@margoengine/sciviz';

export const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
export const signal = AbortSignal.timeout(120_000);
export const fail = (error: unknown) => {
  element('status').textContent = `Could not display data: ${(error as Error).message}`;
  document.querySelector('canvas')!.dataset.error = String(error);
};

export async function floats(url: URL): Promise<Float32Array> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${response.status} loading ${url.pathname}`);
  const data = response.body!.pipeThrough(new DecompressionStream('gzip'));
  return new Float32Array(await new Response(data).arrayBuffer());
}

export function exportButton(figure: Figure, name: string): void {
  element('export').addEventListener('click', () => {
    void figure
      .toPNG()
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${name}.png`;
        link.click();
        URL.revokeObjectURL(url);
      })
      .catch(fail);
  });
}
