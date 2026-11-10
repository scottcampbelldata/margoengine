import { Figure, loadSpecData, type SpecDataURL } from '@margoengine/sciviz/spec';

export async function numericURLInputs(figure: Figure, source: SpecDataURL): Promise<void> {
  const data = await loadSpecData(source);
  await figure.scatter({ x: data, y: data });
  figure.surface(data);
}
