// Small helpers shared by the real-data demos. Data and plotting stay in each page's source.
import { Figure, type CreateFigureOptions } from '@margoengine/sciviz/spec';

// ?backend=webgl2 demonstrates the complete shared renderer, including CPU isosurfaces.
export async function createFigure(canvas: HTMLCanvasElement, options: CreateFigureOptions = {}): Promise<Figure> {
  if (new URLSearchParams(location.search).get('backend') === 'webgl2') {
    const { createFallbackFigure } = await import('@margoengine/sciviz/fallback');
    return Figure.record(await createFallbackFigure(canvas, options), options);
  }
  return Figure.create(canvas, options);
}

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
