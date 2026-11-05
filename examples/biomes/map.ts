// The world map beside the terrain: the region fields of a BiomeWorld sampled on a grid (world.sampleRegion) and drawn
// as one of five layers with a hillshade from the same heights. Sampling runs a few milliseconds per frame, so a
// climate change never stalls the page. Everything shown comes from @margoengine/biomes; nothing here models climate.
import type { BiomeSample, BiomeWorld } from '@margoengine/biomes';
import { KOPPEN, koppenClass } from '@margoengine/biomes/koppen';

export type MapLayer = 'biome' | 'koppen' | 'temperature' | 'rainfall' | 'soil';

/** Map colours of the preset biomes; a biome of your own gets grey. */
export const BIOME_COLORS: Readonly<Record<string, string>> = {
  temperate: '#6a9a3c',
  boreal: '#2f5f3c',
  alpine: '#b4b5a6',
  wetland: '#4d8a7a',
  tundra: '#a39c74',
  desert: '#e0c07c',
  savanna: '#c9a347',
  tropical: '#1e7a40',
  beach: '#efe2b5',
};

/** Koppen-Geiger map colours, the legend most climate atlases use. */
const KOPPEN_COLORS: Readonly<Record<string, string>> = {
  Af: '#0000ff',
  Am: '#0078ff',
  Aw: '#46aafa',
  As: '#46aafa',
  BWh: '#ff0000',
  BWk: '#ff9696',
  BSh: '#f5a500',
  BSk: '#ffdc64',
  Csa: '#ffff00',
  Csb: '#c8c800',
  Csc: '#969600',
  Cwa: '#96ff96',
  Cwb: '#64c864',
  Cwc: '#329632',
  Cfa: '#c8ff50',
  Cfb: '#64ff50',
  Cfc: '#32c800',
  Dsa: '#ff00ff',
  Dsb: '#c800c8',
  Dsc: '#963296',
  Dsd: '#966496',
  Dwa: '#aaafff',
  Dwb: '#5a78dc',
  Dwc: '#4b50b4',
  Dwd: '#320087',
  Dfa: '#00ffff',
  Dfb: '#37c8ff',
  Dfc: '#007d7d',
  Dfd: '#00465f',
  ET: '#b2b2b2',
  EF: '#666666',
};

const SEA = [38, 86, 118];
const N = 128;

const rgb = (hex: string): [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];
const mix = (a: readonly number[], b: readonly number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);
/** A colour ramp through evenly spaced stops, t in 0..1. */
function ramp(stops: readonly string[], t: number): number[] {
  const c = stops.map(rgb),
    x = Math.min(Math.max(t, 0), 1) * (c.length - 1),
    i = Math.min(Math.floor(x), c.length - 2);
  return mix(c[i], c[i + 1], x - i);
}

/** Continuous layers: value range, unit and colour stops. */
const SCALES = {
  temperature: { min: -15, max: 30, unit: 'C', stops: ['#2b4a9c', '#7fb2e0', '#f2f0e6', '#f0b25a', '#c8382c'] },
  rainfall: { min: 0, max: 3500, unit: 'mm a year', stops: ['#d9c08a', '#9cc06a', '#3c9a6a', '#2a6aa8', '#203a8a'] },
  soil: { min: 0, max: 2.55, unit: 'm deep', stops: ['#efe3c4', '#b98a52', '#6a4526', '#3a2614'] },
} as const;

export const pretty = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);

/** The climate of one point in a sentence, for the probe readout. */
export function describe(world: BiomeWorld, s: BiomeSample, x: number, z: number): string {
  const share = s.biomes.map((id, i) => `${pretty(id)} ${Math.round(s.weights[i] * 100)} %`).join(', '),
    sea = s.height < world.climate.sea / 1000;
  return (
    `${sea ? 'Under the sea. ' : ''}${share}. Koppen ${KOPPEN[koppenOf(world, s)]}. ` +
    `${s.temperature.toFixed(1)} C a year (${s.coldest.toFixed(1)} to ${s.warmest.toFixed(1)}), ` +
    `${Math.round(s.rainfall).toLocaleString('en')} mm of rain, soil ${s.soil.toFixed(2)} m, ` +
    `${Math.round(s.height).toLocaleString('en')} m high at ${Math.round(x)}, ${Math.round(z)}.`
  );
}

function koppenOf(world: BiomeWorld, s: BiomeSample): number {
  return koppenClass({
    temperature: Math.round(s.temperature * 100),
    coldest: Math.round(s.coldest * 100),
    warmest: Math.round(s.warmest * 100),
    rainfall: Math.round(s.rainfall),
    rainSeason: world.climate.rainSeason,
  });
}

// A plain task yield, not requestAnimationFrame: a hidden tab gets no frames and the map would never finish.
const frame = () => new Promise<void>((done) => setTimeout(done, 0));

/** The map: samples a world, draws a layer, marks the camera and turns map pixels into world metres. */
export class WorldMap {
  readonly canvas: HTMLCanvasElement;
  readonly #legend: HTMLElement;
  readonly #base: HTMLCanvasElement = document.createElement('canvas');
  readonly #biome = new Uint8Array(N * N);
  readonly #koppen = new Uint8Array(N * N);
  readonly #temperature = new Float32Array(N * N);
  readonly #rainfall = new Float32Array(N * N);
  readonly #soil = new Float32Array(N * N);
  readonly #height = new Float32Array(N * N);
  #world?: BiomeWorld;
  #ids: string[] = [];
  #job = 0;
  #layer: MapLayer = 'biome';
  #marker?: { x: number; z: number; yaw: number };
  #ready = false;

  constructor(canvas: HTMLCanvasElement, legend: HTMLElement) {
    this.canvas = canvas;
    this.#legend = legend;
    this.#base.width = this.#base.height = N;
  }

  /** Samples `world` again (after any change) and redraws when done. Resolves false when a newer call took over. */
  async sample(world: BiomeWorld): Promise<boolean> {
    const job = ++this.#job,
      [x0, z0, x1, z1] = world.bounds,
      sx = (x1 - x0) / N,
      sz = (z1 - z0) / N;
    this.#world = world;
    this.#ids = world.biomes.map((b) => b.id);
    let out: BiomeSample | undefined,
      since = performance.now();
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        out = world.sampleRegion(x0 + (i + 0.5) * sx, z0 + (j + 0.5) * sz, out);
        this.#biome[k] = Math.max(0, this.#ids.indexOf(out.biomes[0]));
        this.#koppen[k] = koppenOf(world, out);
        this.#temperature[k] = out.temperature;
        this.#rainfall[k] = out.rainfall;
        this.#soil[k] = out.soil;
        this.#height[k] = out.height;
      }
      if (performance.now() - since > 6) {
        await frame();
        if (job !== this.#job) return false;
        since = performance.now();
      }
    }
    this.#ready = true;
    this.draw();
    return true;
  }

  set layer(layer: MapLayer) {
    this.#layer = layer;
    this.draw();
  }

  /** The camera's ground point and heading, drawn as a pointer. */
  mark(x: number, z: number, yaw: number): void {
    const m = this.#marker;
    if (m && Math.abs(m.x - x) < 4 && Math.abs(m.z - z) < 4 && Math.abs(m.yaw - yaw) < 0.02) return;
    this.#marker = { x, z, yaw };
    this.#present();
  }

  /** World metres under a pointer event on the map. */
  toWorld(event: PointerEvent): [number, number] | undefined {
    const world = this.#world;
    if (!world) return undefined;
    const r = this.canvas.getBoundingClientRect(),
      [x0, z0, x1, z1] = world.bounds,
      u = (event.clientX - r.left) / r.width,
      v = (event.clientY - r.top) / r.height;
    if (u < 0 || u > 1 || v < 0 || v > 1) return undefined;
    return [x0 + u * (x1 - x0), z0 + v * (z1 - z0)];
  }

  draw(): void {
    const world = this.#world;
    if (!world || !this.#ready) return;
    const image = new ImageData(N, N),
      sea = world.climate.sea / 1000,
      layer = this.#layer,
      biomeRgb = this.#ids.map((id) => rgb(BIOME_COLORS[id] ?? '#8a8a80')),
      koppenRgb = KOPPEN.map((code) => rgb(KOPPEN_COLORS[code] ?? '#8a8a80')),
      cell = (world.bounds[2] - world.bounds[0]) / N;
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const k = j * N + i,
          h = this.#height,
          west = h[j * N + Math.max(i - 1, 0)],
          east = h[j * N + Math.min(i + 1, N - 1)],
          north = h[Math.max(j - 1, 0) * N + i],
          south = h[Math.min(j + 1, N - 1) * N + i],
          // Light from the north-west: slopes facing it brighten, slopes away darken.
          shade = Math.min(Math.max(1 + ((west - east + north - south) / (2 * cell)) * 0.9, 0.55), 1.3),
          under = h[k] < sea;
        let c: readonly number[];
        if (layer === 'biome') c = under ? SEA : biomeRgb[this.#biome[k]];
        else if (layer === 'koppen') c = under ? SEA : koppenRgb[this.#koppen[k]];
        else {
          const s = SCALES[layer],
            v = (layer === 'temperature' ? this.#temperature : layer === 'rainfall' ? this.#rainfall : this.#soil)[k];
          c = ramp(s.stops, (v - s.min) / (s.max - s.min));
        }
        const lit = under ? 1 : shade;
        image.data[k * 4] = c[0] * lit;
        image.data[k * 4 + 1] = c[1] * lit;
        image.data[k * 4 + 2] = c[2] * lit;
        image.data[k * 4 + 3] = 255;
      }
    this.#base.getContext('2d')!.putImageData(image, 0, 0);
    this.#present();
    this.#drawLegend();
  }

  #present(): void {
    const world = this.#world;
    if (!world || !this.#ready) return;
    const g = this.canvas.getContext('2d')!,
      w = this.canvas.width,
      [x0, z0, x1, z1] = world.bounds;
    g.imageSmoothingEnabled = true;
    g.drawImage(this.#base, 0, 0, w, w);
    const m = this.#marker;
    if (!m) return;
    const px = ((m.x - x0) / (x1 - x0)) * w,
      pz = ((m.z - z0) / (z1 - z0)) * w;
    g.save();
    g.translate(px, pz);
    g.rotate(m.yaw);
    g.beginPath();
    g.moveTo(0, -11);
    g.lineTo(7, 7);
    g.lineTo(0, 3);
    g.lineTo(-7, 7);
    g.closePath();
    g.fillStyle = '#fff';
    g.strokeStyle = '#111';
    g.lineWidth = 2;
    g.stroke();
    g.fill();
    g.restore();
  }

  #drawLegend(): void {
    const items: string[] = [],
      layer = this.#layer;
    if (layer === 'biome' || layer === 'koppen') {
      const counts = new Map<number, number>(),
        source = layer === 'biome' ? this.#biome : this.#koppen,
        sea = (this.#world?.climate.sea ?? 0) / 1000;
      for (let k = 0; k < N * N; k++)
        if (this.#height[k] >= sea) counts.set(source[k], (counts.get(source[k]) ?? 0) + 1);
      for (const [index, count] of [...counts].sort((a, b) => b[1] - a[1])) {
        if (count < N * N * 0.002) continue;
        const label = layer === 'biome' ? pretty(this.#ids[index]) : KOPPEN[index],
          color =
            layer === 'biome' ? (BIOME_COLORS[this.#ids[index]] ?? '#8a8a80') : (KOPPEN_COLORS[label] ?? '#8a8a80');
        items.push(`<li><i style="background:${color}"></i>${label}</li>`);
      }
      if ([...this.#height].some((h) => h < sea)) items.push(`<li><i style="background:rgb(${SEA})"></i>Sea</li>`);
    } else {
      const s = SCALES[layer];
      items.push(
        `<li class="ramp" style="background:linear-gradient(90deg,${s.stops.join(',')})" aria-hidden="true"></li>`,
        `<li class="ends"><span>${s.min} ${s.unit}</span><span>${s.max.toLocaleString('en')} ${s.unit}</span></li>`,
      );
    }
    this.#legend.innerHTML = items.join('');
  }
}
