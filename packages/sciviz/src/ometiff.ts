import { openTIFF, type TIFFFile, type TIFFSamples } from '@margoengine/decoders/tiff';
import { readXMLTree, type XMLElement } from '@margoengine/loaders/xml';
import { rangeError } from '../../shared/errors.js';
import { whole, resource, type EngineeringOptions } from './engineering-common.js';
import type { FileInput } from './file-source.js';
import type { ScientificImage } from './scientific-image.js';
export { imageGrid as omeTIFFGrid, imageVolume as volumeFromOMETIFF } from './scientific-image.js';

/** OME series selection and bounded companion resolution. */
export interface OMETIFFOptions extends EngineeringOptions {
  readonly series?: number;
}
/** One logical OME channel, possibly holding interleaved RGB samples. */
export interface OMEChannel {
  readonly name: string;
  readonly samplesPerPixel: number;
  readonly color?: number;
}
/** A selected OME Image, lazy Z/C/T plane decode, with original quantitative samples. */
export interface OMETIFFStack {
  readonly name: string;
  readonly xml: string;
  readonly size: Readonly<Record<'X' | 'Y' | 'Z' | 'C' | 'T', number>>;
  readonly dimensionOrder: string;
  readonly pixelType: string;
  readonly channels: readonly OMEChannel[];
  readonly spacing: readonly number[];
  readonly units: readonly string[];
  plane(z?: number, c?: number, t?: number): Promise<TIFFSamples>;
  image(c?: number, t?: number): Promise<ScientificImage>;
}
const bad = (s: string): never => {
  throw rangeError(`OME-TIFF: ${s}; check OME-XML and companion files`, 'sciviz');
};
const child = (e: XMLElement, n: string) => e.children.find((c) => c.name === n);
const positive = (s: string | undefined, d = 1) => {
  const n = Number(s ?? d);
  if (!Number.isSafeInteger(n) || n < 1) bad('invalid dimension');
  return n;
};
/** Opens classic TIFF or BigTIFF OME stacks. TiffData overrides DimensionOrder, including multi-file UUIDs. */
export async function readOMETIFF(input: FileInput, options: OMETIFFOptions = {}): Promise<OMETIFFStack> {
  const bytes = await whole(input, options),
    maxPixels = Math.floor((options.maxBytes ?? 64 * 1024 * 1024) / 8),
    file = openTIFF(bytes, { maxPixels }),
    xml = file.descriptions[0];
  const root = readXMLTree(xml, 'OME-TIFF'),
    ome = root.children.find((c) => c.name === 'OME');
  if (!ome) bad('missing OME root');
  const images = ome!.children.filter((c) => c.name === 'Image'),
    series = options.series ?? 0;
  if (!Number.isInteger(series) || series < 0 || series >= images.length) bad('series index outside images');
  const image = images[series],
    pixels = child(image, 'Pixels');
  if (!pixels) bad('missing Pixels');
  const a = pixels!.attributes,
    size = {
      X: positive(a.SizeX),
      Y: positive(a.SizeY),
      Z: positive(a.SizeZ),
      C: positive(a.SizeC),
      T: positive(a.SizeT),
    },
    dimensionOrder = a.DimensionOrder;
  if (!/^XY(ZCT|ZTC|CZT|CTZ|TCZ|TZC)$/.test(dimensionOrder)) bad('invalid DimensionOrder');
  const channels = pixels!.children
    .filter((c) => c.name === 'Channel')
    .map((c, i) => ({
      name: c.attributes.Name ?? c.attributes.ID ?? `channel${i}`,
      samplesPerPixel: positive(c.attributes.SamplesPerPixel),
      color: c.attributes.Color === undefined ? undefined : Number(c.attributes.Color),
    }));
  if (!channels.length)
    for (let c = 0; c < size.C; c++) channels.push({ name: `channel${c}`, samplesPerPixel: 1, color: undefined });
  if (channels.reduce((n, c) => n + c.samplesPerPixel, 0) !== size.C) bad('channel samples differ from SizeC');
  const effectiveC = channels.length,
    counts: Record<string, number> = { Z: size.Z, C: effectiveC, T: size.T },
    order = dimensionOrder.slice(2).split('');
  const encode = (p: Record<string, number>) => {
    let stride = 1,
      n = 0;
    for (const axis of order) {
      n += p[axis] * stride;
      stride *= counts[axis];
    }
    return n;
  };
  const cIndex = (c: number) => {
    let n = 0;
    for (let i = 0; i < channels.length; i++) {
      if (c === n) return i;
      n += channels[i].samplesPerPixel;
    }
    return bad('TiffData FirstC does not begin a channel');
  };
  const mapping = new Map<number, { ifd: number; name?: string }>(),
    files = new Map<string, Promise<TIFFFile>>();
  const tiffData = pixels!.children.filter((c) => c.name === 'TiffData');
  if (!tiffData.length) bad('no TiffData');
  for (const td of tiffData) {
    const t = td.attributes,
      ifd = Number(t.IFD ?? 0),
      z = Number(t.FirstZ ?? 0),
      c = cIndex(Number(t.FirstC ?? 0)),
      time = Number(t.FirstT ?? 0);
    if (![z, c, time].every((n, i) => Number.isInteger(n) && n >= 0 && n < [size.Z, effectiveC, size.T][i]))
      bad('TiffData origin outside dimensions');
    const base = encode({ Z: z, C: c, T: time }),
      count = Number(
        t.PlaneCount ?? (t.IFD !== undefined ? 1 : Math.min(file.length, size.Z * effectiveC * size.T - base)),
      ),
      uuid = child(td, 'UUID'),
      name = uuid?.attributes.FileName;
    if (
      ![ifd, base, count].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      base + count > size.Z * effectiveC * size.T
    )
      bad('invalid TiffData range');
    const sameUUID = uuid?.text.trim() === ome!.attributes.UUID;
    if (uuid && !sameUUID && !name) bad('external UUID needs FileName for resource resolution');
    for (let j = 0; j < count; j++) {
      if (mapping.has(base + j)) bad('duplicate plane mapping');
      mapping.set(base + j, { ifd: ifd + j, name: name && !sameUUID ? name : undefined });
    }
  }
  const spacing = ['X', 'Y', 'Z'].map((k) => Number(a[`PhysicalSize${k}`] ?? 1)),
    units = ['X', 'Y', 'Z'].map((k) => a[`PhysicalSize${k}Unit`] ?? 'µm');
  if (spacing.some((n) => !Number.isFinite(n) || n <= 0)) bad('invalid physical spacing');
  const getFile = (name: string): Promise<TIFFFile> => {
    if (!files.has(name))
      files.set(
        name,
        (async () => openTIFF(await whole(await resource(name, input, options), options), { maxPixels }))(),
      );
    return files.get(name)!;
  };
  const plane = async (z = 0, c = 0, t = 0): Promise<TIFFSamples> => {
    options.signal?.throwIfAborted();
    if (![z, c, t].every((n, i) => Number.isInteger(n) && n >= 0 && n < [size.Z, size.C, size.T][i]))
      bad('plane selection outside dimensions');
    let channel = 0,
      offset = 0;
    while (c >= offset + channels[channel].samplesPerPixel) {
      offset += channels[channel].samplesPerPixel;
      channel++;
    }
    const map = mapping.get(encode({ Z: z, C: channel, T: t }));
    if (!map) bad('plane is not mapped');
    const source = map!.name ? await getFile(map!.name) : file,
      page = source.read(map!.ifd, options.signal);
    if (page.width !== size.X || page.height !== size.Y || page.samplesPerPixel !== channels[channel].samplesPerPixel)
      bad('IFD shape differs from OME Pixels');
    const expected: Record<string, [number, number]> = {
      uint8: [8, 1],
      uint16: [16, 1],
      uint32: [32, 1],
      int8: [8, 2],
      int16: [16, 2],
      int32: [32, 2],
      float: [32, 3],
      double: [64, 3],
      bit: [1, 1],
    };
    const fmt = expected[a.Type];
    if (!fmt || fmt[0] !== page.bits || fmt[1] !== page.sampleFormat) bad('IFD sample format differs from OME Type');
    if (page.samplesPerPixel === 1) return page.samples;
    const out = new (page.samples.constructor as { new (length: number): TIFFSamples })(size.X * size.Y);
    for (let i = 0; i < out.length; i++) out[i] = page.samples[i * page.samplesPerPixel + c - offset];
    return out;
  };
  return {
    name: image.attributes.Name ?? image.attributes.ID ?? '',
    xml,
    size,
    dimensionOrder,
    pixelType: a.Type,
    channels,
    spacing,
    units,
    plane,
    async image(c = 0, t = 0) {
      const n = size.X * size.Y * size.Z;
      if (!Number.isSafeInteger(n) || n * 8 > (options.maxBytes ?? 64 * 1024 * 1024)) bad('volume exceeds maxBytes');
      const data = new Float64Array(n);
      for (let z = 0; z < size.Z; z++) data.set(await plane(z, c, t), z * size.X * size.Y);
      const planes = pixels!.children.filter((p) => p.name === 'Plane'),
        firstPlane = planes.find(
          (p) =>
            Number(p.attributes.TheZ ?? 0) === 0 &&
            Number(p.attributes.TheC ?? 0) === c &&
            Number(p.attributes.TheT ?? 0) === t,
        ),
        origin = ['X', 'Y', 'Z'].map((k) => Number(firstPlane?.attributes[`Position${k}`] ?? 0));
      return { data, dims: [size.X, size.Y, size.Z], world: (p) => p.map((v, i) => origin[i] + v * spacing[i]) };
    },
  };
}
