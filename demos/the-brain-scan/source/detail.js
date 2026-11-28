import { Colormap, Figure } from '@margoengine/sciviz';

export function createDetail(engine, values, dims, bounds, aspect, position) {
  const figure = Figure.attach(engine, { axes: false, legend: false, tooltips: false, aspect, limits: bounds });
  const colormap = new Colormap('clinical-teal', 'sequential', (value) => {
    const tone = Math.min(1, Math.max(0, (value - .025) * 1.12)) ** .82;
    return [.092 + tone * .816, .143 + tone * .801, .170 + tone * .743];
  });
  try {
    const volume = figure.volume(values, {
      dims, bounds, range: [0, 255], colormap, shading: true, quality: 1.24, density: 1.02,
      opacity: [[0, 0], [.18, 0], [.31, .015], [.52, .059], [.77, .17], [1, .23]],
    });
    const slices = {
      sagittal: volume.slice('x', position.sagittal),
      coronal: volume.slice('y', position.coronal, { opacity: .87 }),
      axial: volume.slice('z', position.axial, { opacity: .87 }),
    };
    return { figure, volume, slices };
  } catch (error) {
    figure.dispose();
    throw error;
  }
}
