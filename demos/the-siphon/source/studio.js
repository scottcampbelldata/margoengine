import { Texture } from '@margoengine/materials';

const lamps = [
  [-.36, .29, .16, .45, [1.55, 1.22, .83]],
  [.44, .22, .19, .34, [.76, 1.13, 1.28]],
  [.02, .69, .51, .11, [1.2, 1.19, 1.05]],
  [-.03, -.42, .48, .17, [.33, .43, .55]],
];

function encode(value) {
  const bounded = Math.max(0, Math.min(1, value));
  return Math.round(255 * (bounded <= .0031308 ? 12.92 * bounded : 1.055 * bounded ** (1 / 2.4) - .055));
}

function mapFinish(finish) {
  const width = 64;
  const height = width;
  const data = new Uint8Array(width * height * 4);
  for (let j = 0; j < height; j++) {
    const y = ((j + .5) / height - .5) / .49;
    for (let i = 0; i < width; i++) {
      const x = ((i + .5) / width - .5) / .49;
      const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
      const reflectiveX = 2 * x * z;
      const reflectiveY = 2 * y * z;
      const facing = 2 * z * z - 1;
      const azimuth = Math.atan2(reflectiveX, facing) / Math.PI;
      const elevation = Math.asin(Math.max(-1, Math.min(1, reflectiveY))) / (Math.PI / 2);
      const rim = (1 - z) ** 2;
      const base = .65 + .36 * Math.max(0, y);
      const light = finish.ambient.map((v) => v * base + rim * finish.rim);
      for (const [u, v, w, h, power] of lamps) {
        const repeat = azimuth - u;
        const dx = repeat - 2 * Math.round(repeat / 2);
        const shape = Math.exp(-1.4 * ((dx / (w * finish.blur)) ** 4 + ((elevation - v) / (h * finish.blur)) ** 4));
        for (let channel = 0; channel < 3; channel++) light[channel] += shape * power[channel] * finish.gloss[channel];
      }
      data.set([...light.map(encode), 255], (j * width + i) * 4);
    }
  }
  return new Texture({ width, height, data }, { colorSpace: 'srgb', magFilter: 'linear', minFilter: 'linear' });
}

export function createStudio() {
  return {
    brass: mapFinish({ ambient: [.24, .138, .052], gloss: [.66, .60, .42], rim: .068, blur: 1.16 }),
    nickel: mapFinish({ ambient: [.15, .18, .20], gloss: [.59, .64, .67], rim: .091, blur: 1.04 }),
    glass: mapFinish({ ambient: [.031, .068, .085], gloss: [.60, .86, .96], rim: .43, blur: .91 }),
    water: mapFinish({ ambient: [.042, .156, .234], gloss: [.125, .36, .44], rim: .072, blur: 1.22 }),
  };
}