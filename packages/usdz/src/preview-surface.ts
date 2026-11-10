import { LoaderError } from '@margoengine/loaders/common';
import type { ExtensionHooks, SurfaceRead, USDExtension, USDImagePlacement, USDSurface } from './extension.js';
import { flat } from './clip.js';
import { attachPreviewOpacity } from './preview-opacity.js';
import { primvarStream } from './primvar-stream.js';
import type { PreviewOpacity } from './preview-opacity.js';

const bad = (message: string): never => {
  throw new LoaderError('USD', 'syntax', message + '; fix the PreviewSurface network');
};
const values = (value: unknown, width: number, fallback: number[]): number[] => {
  const v = value === undefined ? fallback : typeof value === 'number' ? [value] : flat(value);
  if (v.length !== width || v.some((n) => !Number.isFinite(n))) bad('invalid shader value');
  return v;
};
function surface(read: SurfaceRead): USDSurface | undefined {
  const { attr, connection } = read;
  const output = connection(read.path, 'outputs:surface'),
    shader = output?.split('.outputs:')[0];
  if (!shader || attr(shader, 'info:id') !== 'UsdPreviewSurface') return;
  const input = (path: string, name: string): unknown => {
    const target = connection(path, name);
    if (!target) return attr(path, name);
    const dot = target.lastIndexOf('.'),
      prim = target.slice(0, dot),
      id = String(attr(prim, 'info:id') ?? '');
    return id.startsWith('UsdPrimvarReader_') ? attr(prim, 'inputs:fallback') : attr(prim, target.slice(dot + 1));
  };
  const reader = (name: string, width: number) => {
    const node = connection(shader, 'inputs:' + name)?.split('.outputs:')[0];
    const ids = [
      `UsdPrimvarReader_float${width === 1 ? '' : width}`,
      ...(width === 3 ? ['UsdPrimvarReader_normal', 'UsdPrimvarReader_point', 'UsdPrimvarReader_vector'] : []),
    ];
    if (!node || !ids.includes(String(attr(node, 'info:id')))) return;
    const varname = input(node, 'inputs:varname');
    if (typeof varname !== 'string' || !varname) bad('primvar reader requires varname');
    return {
      name: varname as string,
      fallback: values(attr(node, 'inputs:fallback'), width, new Array(width).fill(0)),
    };
  };
  const uv = (node: string): string | undefined => {
    let st = connection(node, 'inputs:st')?.split('.outputs:')[0];
    if (st && attr(st, 'info:id') === 'UsdTransform2d') st = connection(st, 'inputs:in')?.split('.outputs:')[0];
    const name = st && input(st, 'inputs:varname');
    return typeof name === 'string' ? name : undefined;
  };
  const texture = (name: string) => {
    const target = connection(shader, 'inputs:' + name),
      node = target?.split('.outputs:')[0];
    if (!node || attr(node, 'info:id') !== 'UsdUVTexture') return;
    const file = input(node, 'inputs:file');
    if (typeof file !== 'string') bad('texture requires file');
    const channel = target!.split('.outputs:')[1],
      index = 'rgba'.indexOf(channel);
    if (index < 0 && channel !== 'rgb') bad('unknown texture output');
    const wrap: Record<string, number> = { repeat: 10497, mirror: 33648, clamp: 33071, useMetadata: 10497 };
    const where: USDImagePlacement = {
      wrapS: wrap[String(attr(node, 'inputs:wrapS') ?? 'repeat')] ?? 10497,
      wrapT: wrap[String(attr(node, 'inputs:wrapT') ?? 'repeat')] ?? 10497,
    };
    const transform = connection(node, 'inputs:st')?.split('.outputs:')[0];
    if (transform && attr(transform, 'info:id') === 'UsdTransform2d') {
      const scale = values(attr(transform, 'inputs:scale'), 2, [1, 1]),
        translation = values(attr(transform, 'inputs:translation'), 2, [0, 0]),
        rotation = (values(attr(transform, 'inputs:rotation'), 1, [0])[0] * Math.PI) / 180;
      where.transform = {
        offset: [translation[0] - Math.sin(rotation) * scale[1], 1 - Math.cos(rotation) * scale[1] - translation[1]],
        rotation,
        scale: [scale[0], scale[1]],
      };
    }
    return {
      path: read.resolve(file as string),
      channel: Math.max(0, index),
      where,
      uv: uv(node),
      scale: values(attr(node, 'inputs:scale'), 4, [1, 1, 1, 1]),
      bias: values(attr(node, 'inputs:bias'), 4, [0, 0, 0, 0]),
      srgb: attr(node, 'inputs:sourceColorSpace') === 'sRGB',
    };
  };
  const color = reader('diffuseColor', 3),
    opacity = reader('opacity', 1),
    diffuse = texture('diffuseColor'),
    alpha = texture('opacity'),
    normal = texture('normal'),
    rough = texture('roughness'),
    metal = texture('metallic'),
    emit = texture('emissiveColor');
  const widths: Record<string, number> = {
    diffuseColor: 3,
    opacity: 1,
    normal: 3,
    emissiveColor: 3,
    roughness: 1,
    metallic: 1,
    occlusion: 1,
    clearcoat: 1,
    clearcoatRoughness: 1,
    ior: 1,
    specularColor: 3,
  };
  const readers = Object.entries(widths).flatMap(([input, width]) => {
    const found = reader(input, width);
    return found ? [{ ...found, input, width }] : [];
  });
  const scalar = (name: string, fallback: number) => values(input(shader, 'inputs:' + name), 1, [fallback])[0];
  const threshold = scalar('opacityThreshold', 0),
    factor = scalar('opacity', 1);
  const material: USDSurface['material'] = {
    name: read.path,
    doubleSided: true,
    alphaMode: alpha || opacity || factor < 1 ? (threshold > 0 ? 'MASK' : 'BLEND') : 'OPAQUE',
    pbrMetallicRoughness: {
      baseColorFactor: [
        ...(diffuse || color ? [1, 1, 1] : values(input(shader, 'inputs:diffuseColor'), 3, [0.18, 0.18, 0.18])),
        opacity ? 1 : factor,
      ],
      roughnessFactor: scalar('roughness', 0.5),
      metallicFactor: scalar('metallic', 0),
    },
  };
  const p = material.pbrMetallicRoughness!;
  material.extras = {
    usdPreviewStraightAlpha: true,
    usdPreviewReaders: readers,
    ...(readers.length ? { usdPreviewCoordinates: { texCoord: 2 } } : {}),
  };
  if (readers.some((r) => ['clearcoat', 'clearcoatRoughness', 'ior', 'specularColor'].includes(r.input))) {
    material.extras = { ...(material.extras as object), usdPreviewPhysical: { clearcoat: scalar('clearcoat', 0) } };
    material.extensions = {
      KHR_materials_clearcoat: {
        clearcoatFactor: 1,
        clearcoatRoughnessFactor: scalar('clearcoatRoughness', 0.01),
      },
      KHR_materials_ior: { ior: 1.5 },
    };
  }
  if (threshold > 0) material.alphaCutoff = threshold;
  if (diffuse) p.baseColorTexture = read.image({ path: diffuse.path }, diffuse.where);
  if (normal) material.normalTexture = read.image({ path: normal.path }, normal.where);
  if (rough || metal) {
    if (rough && metal && JSON.stringify(rough.where) !== JSON.stringify(metal.where))
      bad('metal and roughness sampling differs');
    p.metallicRoughnessTexture = read.image(
      {
        roughness: rough && { path: rough.path, channel: rough.channel },
        metallic: metal && { path: metal.path, channel: metal.channel },
        roughnessValue: p.roughnessFactor,
        metallicValue: p.metallicFactor,
      },
      (rough ?? metal)!.where,
    );
    p.roughnessFactor = p.metallicFactor = 1;
  }
  material.emissiveFactor = values(input(shader, 'inputs:emissiveColor'), 3, [0, 0, 0]);
  if (emit) {
    material.emissiveTexture = read.image({ path: emit.path }, emit.where);
    material.emissiveFactor = [1, 1, 1];
  }
  if (alpha) {
    const info = read.image(
      {
        path: alpha.path,
        opacity: {
          channel: alpha.channel,
          scale: alpha.scale[alpha.channel],
          bias: alpha.bias[alpha.channel],
          srgb: alpha.srgb,
        },
      },
      alpha.where,
    );
    material.extras = {
      ...(material.extras as object),
      usdPreviewOpacity: { texture: info.index, uv: alpha.uv, where: alpha.where },
    };
  }
  return { material, color, opacity, uv: diffuse?.uv ?? normal?.uv ?? rough?.uv ?? metal?.uv ?? alpha?.uv };
}

/** Import independent opacity maps and arbitrary named color, opacity and UV primvar readers in UsdPreviewSurface. */
export function previewSurface(): USDExtension {
  const hook: ExtensionHooks = {
    name: 'preview-surface',
    decoders: async () => ({ materials: (await import('@margoengine/gltf-pro/extended')).extendedMaterials }),
    surface,
    created: attachPreviewOpacity,
    prepare({ specs }) {
      const inherited = new Map<string, Map<string, (typeof specs)[string]>>();
      const properties = new Map<string, [string, (typeof specs)[string]][]>();
      for (const [path, spec] of Object.entries(specs))
        if (path.includes('.primvars:')) {
          const dot = path.indexOf('.'),
            owner = path.slice(0, dot),
            name = path.slice(dot);
          const list = properties.get(owner) ?? [];
          list.push([name, spec]);
          properties.set(owner, list);
        }
      for (const [path, spec] of Object.entries(specs).sort(([a], [b]) => a.split('/').length - b.split('/').length))
        if (spec.specType === 6) {
          const parent = path.slice(0, path.lastIndexOf('/')),
            values = new Map(inherited.get(parent));
          const own = properties.get(path) ?? [];
          for (const [name, value] of own) {
            if (!name.endsWith(':indices') && !own.some(([key]) => key === name + ':indices'))
              values.delete(name + ':indices');
            values.set(name, value);
          }
          for (const [name, value] of values) {
            if (!specs[path + name] && (value.fields.interpolation ?? 'constant') === 'constant')
              specs[path + name] = value;
            if ((value.fields.interpolation ?? 'constant') !== 'constant') {
              values.delete(name);
              values.delete(name + ':indices');
            }
          }
          inherited.set(path, values);
        }
    },
    geometry(read) {
      for (const mesh of read.meshes)
        for (const primitive of read.document.meshes![mesh.mesh].primitives) {
          const material = read.document.materials![primitive.material!],
            data = (material.extras as { usdPreviewOpacity?: PreviewOpacity } | undefined)?.usdPreviewOpacity;
          const readers =
            (
              material.extras as
                | { usdPreviewReaders?: { name: string; input: string; width: number; fallback: number[] }[] }
                | undefined
            )?.usdPreviewReaders ?? [];
          if (readers.length) {
            const count = mesh.vertexOf.length,
              packed = new Float32Array(count * readers.length * 4),
              coordinates = new Float32Array(count * 2),
              barycentric = new Float32Array(count * 2);
            const streams = readers.map((r) => primvarStream(read, mesh, r.name, r.width, r.fallback));
            for (let i = 0; i < count; i++) {
              coordinates[i * 2] = Math.floor(i / 3);
              barycentric[i * 2] = i % 3 === 1 ? 1 : 0;
              barycentric[i * 2 + 1] = i % 3 === 2 ? 1 : 0;
              for (let slot = 0; slot < readers.length; slot++)
                for (let d = 0; d < readers[slot].width; d++)
                  packed[(i * readers.length + slot) * 4 + d] = streams[slot][i * readers[slot].width + d];
            }
            primitive.attributes!.TEXCOORD_2 = read.accessor(coordinates, 'VEC2');
            primitive.attributes!.TEXCOORD_3 = read.accessor(barycentric, 'VEC2');
            primitive.extras = {
              ...(primitive.extras as object),
              usdPreviewValues: { accessor: read.accessor(packed, 'VEC4'), inputs: readers.map((r) => r.input) },
            };
          }
          if (!data) continue;
          const stream = primvarStream(read, mesh, data.uv ?? 'st', 2, [0, 0]);
          for (let i = 1; i < stream.length; i += 2) stream[i] = 1 - stream[i];
          primitive.attributes!.TEXCOORD_1 = read.accessor(stream, 'VEC2');
          data.texCoord = 1;
        }
    },
  };
  return hook;
}
