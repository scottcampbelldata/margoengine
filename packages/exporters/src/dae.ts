// COLLADA 1.4.1 (.dae) writer, following the Khronos COLLADA 1.4.1 specification: images, common-profile effects,
// materials, geometries and the node hierarchy. Static pose only: skins, morph targets, animation, cameras and lights
// are not written (the base geometry is).
import { LinearToSRGB as toSrgb } from '@margoengine/math/color';
import {
  collect,
  num,
  polygons,
  samplerOf,
  pixelArtOf,
  textureFiles,
  type ExportSource,
  type Geo,
  type Mat,
  type Node,
  type SceneOptions,
  type TextureData,
  shaper,
} from './scene.js';

/** Options for {@link exportDAE}. */
export interface DAEOptions extends SceneOptions {
  /** Encoding of vertex colors: 'srgb' (default) or 'linear'. Effect colors are always sRGB. */
  colorSpace?: 'srgb' | 'linear';
  /** Prepended to every image path, e.g. 'textures/'. Default ''. */
  texturePrefix?: string;
}

/** The result of {@link exportDAE}. */
export interface DAEResult {
  /** The COLLADA document, ready to save as `.dae`. */
  dae: string;
  /** The image files the document references, keyed by their path relative to the `.dae`; save each there. */
  textures: Map<string, Uint8Array>;
}

// COLLADA 1.4.1 `name` attributes are xs:NCName.
const ncname = (name: string, fallback: string): string => {
  const out = name.replace(/[^\w.-]+/g, '_');
  return !out ? fallback : /^[A-Za-z_]/.test(out) ? out : `_${out}`;
};
const named = (name: string | undefined, id: string) => (name ? ` name="${ncname(name, id)}"` : '');
const rgba = (rgb: readonly number[], alpha = 1) =>
  `${rgb
    .slice(0, 3)
    .map((v) => num(toSrgb(v)))
    .join(' ')} ${num(alpha)}`;
const filters = { nearest: 'NEAREST', linear: 'LINEAR' },
  wraps = { repeat: 'WRAP', clamp: 'CLAMP', mirror: 'MIRROR' };
const same = (v: number) => v;
/** The symbol that ties a node's triangle group to its `<instance_material>`. */
const symbolOf = (index: number) => (index ? `material-${index}` : 'material');

/**
 * Exports a COLLADA 1.4.1 document (Y up, meters) with the scene's node hierarchy as row-major matrices, one geometry
 * per shared geometry (positions, normals, TEXCOORD and COLOR sources; `<triangles>`, or `<polylist>` when
 * `faceSizes` marks quads), a node of several primitives being one geometry of several groups, since Godot's reader
 * takes one `<instance_geometry>` a node, and one material per shared material: `constant` for unlit, `lambert` for `shading:
 * 'lambert'`, `phong` with its `specular` and `shininess` for `shading: 'phong'`; a standard material becomes
 * `lambert` when it is a rough dielectric (roughness 1, metalness 0), else an equivalent `phong`. Each has a base
 * color or texture and transparency for MASK and BLEND. Image paths are relative to the document; the image files come back in `textures`. Static pose only:
 * skins, morph targets, animation, cameras and lights are not written.
 */
export function exportDAE(source: ExportSource, options: DAEOptions = {}): DAEResult {
  const colorSpace = options.colorSpace ?? 'srgb';
  if (colorSpace !== 'srgb' && colorSpace !== 'linear') throw new TypeError("colorSpace must be 'srgb' or 'linear'");
  const pixelArt = pixelArtOf(options.pixelArt),
    files = textureFiles(options.texturePrefix ?? ''),
    roots = collect(source, options),
    encode = colorSpace === 'srgb' ? toSrgb : same;
  if (!roots.length) throw new TypeError('DAE export needs a visible node; a COLLADA visual scene cannot be empty');
  const images = new Map<string, string>(),
    materialIds = new Map<Mat, string>(),
    geometryIds = new Map<string, string>(),
    geoNumbers = new Map<Geo, number>(),
    effects: string[] = [],
    materials: string[] = [],
    geometries: string[] = [];

  const image = (texture: TextureData): string => {
    const file = files.name(texture);
    let id = images.get(file);
    if (!id) images.set(file, (id = `image-${images.size}`));
    return id;
  };

  const material = (mat: Mat): string => {
    let id = materialIds.get(mat);
    if (id) return id;
    const effect = `effect-${materialIds.size}`,
      params: string[] = [],
      texture = mat.baseColorTexture;
    id = `material-${materialIds.size}`;
    materialIds.set(mat, id);
    let base = `<color>${rgba(mat.color)}</color>`;
    if (texture) {
      const img = image(texture),
        s = samplerOf(texture, pixelArt),
        min = s.mipmaps
          ? s.minFilter === 'nearest'
            ? 'NEAREST_MIPMAP_NEAREST'
            : 'LINEAR_MIPMAP_LINEAR'
          : filters[s.minFilter];
      params.push(
        `<newparam sid="${img}-surface"><surface type="2D"><init_from>${img}</init_from></surface></newparam>`,
        `<newparam sid="${img}-sampler"><sampler2D><source>${img}-surface</source><wrap_s>${wraps[s.wrapS]}</wrap_s>` +
          `<wrap_t>${wraps[s.wrapT]}</wrap_t><minfilter>${min}</minfilter><magfilter>${filters[s.magFilter]}</magfilter>` +
          '</sampler2D></newparam>',
      );
      base = `<texture texture="${img}-sampler" texcoord="UVSET0"/>`;
    }
    // A_ONE: opacity is the alpha of the color or texture times <transparency>.
    const transparent =
      mat.alphaMode === 'OPAQUE'
        ? ''
        : `<transparent opaque="A_ONE">${texture ? base : `<color>0 0 0 ${num(mat.color[3])}</color>`}</transparent>` +
          '<transparency><float>1</float></transparency>';
    const emission = mat.emissive.some((v) => v) ? `<emission><color>${rgba(mat.emissive)}</color></emission>` : '';
    let technique: string;
    if (mat.unlit) technique = `<constant><emission>${base}</emission>${transparent}</constant>`;
    else if (mat.shading === 'lambert' || (mat.shading === 'standard' && mat.roughness === 1 && mat.metalness === 0))
      technique = `<lambert>${emission}<diffuse>${base}</diffuse>${transparent}</lambert>`;
    else if (mat.shading === 'phong')
      technique =
        `<phong>${emission}<diffuse>${base}</diffuse><specular><color>${rgba(mat.specular)}</color></specular>` +
        `<shininess><float>${num(mat.shininess)}</float></shininess>${transparent}</phong>`;
    else {
      // Metals keep their color in the specular term (F0 = mix(0.04, base, metalness)); the exponent is the
      // Blinn-Phong equivalent of the microfacet roughness, 2 / alpha^2 - 2 with alpha = roughness^2.
      const m = mat.metalness,
        diffuse = texture ? base : `<color>${rgba(mat.color.map((v) => v * (1 - m)))}</color>`,
        specular = mat.color.slice(0, 3).map((v) => 0.04 + (v - 0.04) * m);
      technique =
        `<phong>${emission}<diffuse>${diffuse}</diffuse><specular><color>${rgba(specular)}</color></specular>` +
        // Inverse of the Walter et al. 2007 sec. 5.2 mapping: n = 2 / roughness^4 - 2.
        `<shininess><float>${num(2 / Math.max(mat.roughness ** 4, 1e-4) - 2)}</float></shininess>${transparent}</phong>`;
    }
    effects.push(
      `<effect id="${effect}"><profile_COMMON>${params.join('')}<technique sid="common">${technique}</technique></profile_COMMON></effect>`,
    );
    materials.push(`<material id="${id}"${named(mat.name, id)}><instance_effect url="#${effect}"/></material>`);
    return id;
  };

  /** The number that names a geometry in the key of a list of parts. */
  const geoNumber = (geo: Geo): number => {
    let n = geoNumbers.get(geo);
    if (n === undefined) geoNumbers.set(geo, (n = geoNumbers.size));
    return n;
  };

  /** One `<geometry>` for a node's parts: their vertices end to end, one triangle group per part, in part order. */
  const geometry = (geos: Geo[], name: string | undefined): string => {
    const key = geos.map(geoNumber).join(' ');
    let id = geometryIds.get(key);
    if (id) return id;
    id = `geometry-${geometryIds.size}`;
    geometryIds.set(key, id);
    const sources: string[] = [],
      inputs: string[] = [];
    const add = (key: string, values: ArrayLike<number>, params: string, input = '') => {
      const s = `${id}-${key}`;
      sources.push(
        `<source id="${s}"><float_array id="${s}-array" count="${values.length}">${Array.from(values, num).join(' ')}</float_array>` +
          `<technique_common><accessor source="#${s}-array" count="${values.length / params.length}" stride="${params.length}">` +
          `${[...params].map((p) => `<param name="${p}" type="float"/>`).join('')}</accessor></technique_common></source>`,
      );
      if (input)
        inputs.push(`<input semantic="${input}" source="#${s}" offset="0"${input === 'NORMAL' ? '' : ' set="0"'}/>`);
    };
    const vertexCount = (geo: Geo) => geo.positions.length / 3,
      colorSize = Math.max(...geos.map((geo) => (geo.colors ? geo.colorSize : 0)));
    add(
      'positions',
      geos.flatMap((geo) => Array.from(geo.positions)),
      'XYZ',
    );
    add(
      'normals',
      geos.flatMap((geo) => Array.from(geo.normals)),
      'XYZ',
      'NORMAL',
    );
    // COLLADA texture coordinates have t up; glTF and Margo Engine have v down. A part without uvs takes zeros, as
    // inputs belong to the whole mesh; nothing reads them, since a textured material needs its part's own uvs.
    if (geos.some((geo) => geo.uvs))
      add(
        'uvs',
        geos.flatMap((geo) =>
          geo.uvs
            ? Array.from(geo.uvs, (v, i) => (i % 2 ? 1 - v : v))
            : new Array<number>(vertexCount(geo) * 2).fill(0),
        ),
        'ST',
        'TEXCOORD',
      );
    // A part without colors is white, which leaves its material as it is; a part of three channels gains alpha 1.
    if (colorSize)
      add(
        'colors',
        geos.flatMap((geo) =>
          Array.from({ length: vertexCount(geo) * colorSize }, (_, i) => {
            const channel = i % colorSize,
              vertex = (i - channel) / colorSize;
            if (!geo.colors || channel >= geo.colorSize) return 1;
            const v = geo.colors[vertex * geo.colorSize + channel]!;
            return channel < 3 ? encode(v) : v;
          }),
        ),
        colorSize === 3 ? 'RGB' : 'RGBA',
        'COLOR',
      );
    const shared = `<input semantic="VERTEX" source="#${id}-vertices" offset="0"/>${inputs.join('')}`;
    let base = 0;
    const groups = geos.map((geo, index) => {
      const faces = polygons(geo.faceSizes, geo.indices),
        symbol = symbolOf(index),
        start = base,
        p = `<p>${faces
          .flat()
          .map((corner) => corner + start)
          .join(' ')}</p>`;
      base += vertexCount(geo);
      return faces.some((face) => face.length === 4)
        ? `<polylist material="${symbol}" count="${faces.length}">${shared}<vcount>${faces.map((f) => f.length).join(' ')}</vcount>${p}</polylist>`
        : `<triangles material="${symbol}" count="${faces.length}">${shared}${p}</triangles>`;
    });
    geometries.push(
      `<geometry id="${id}"${named(name, id)}><mesh>${sources.join('')}` +
        `<vertices id="${id}-vertices"><input semantic="POSITION" source="#${id}-positions"/></vertices>${groups.join('')}</mesh></geometry>`,
    );
    return id;
  };

  let count = 0;
  const shape = shaper(roots);
  const node = (n: Node): string => {
    const id = `node-${count++}`,
      m = n.local,
      rows = [0, 1, 2, 3].flatMap((r) => [m[r], m[4 + r], m[8 + r], m[12 + r]]);
    let out = `<node id="${id}"${named(n.name, id)} type="NODE"><matrix sid="transform">${rows.map(num).join(' ')}</matrix>`;
    const parts: { geometry: Geo; material?: Mat }[] =
      n.primitives ?? (n.geometry ? [{ geometry: n.geometry, material: n.material }] : []);
    if (parts.length) {
      const geos = parts.map(({ geometry: part, material: mat }) => {
          const geo = shape(n, part);
          if (mat?.baseColorTexture && !geo.uvs) throw new TypeError('Textured materials need geometry with uvs');
          return geo;
        }),
        uvInput = geos.some((geo) => geo.uvs)
          ? '<bind_vertex_input semantic="UVSET0" input_semantic="TEXCOORD" input_set="0"/>'
          : '',
        bound = parts.flatMap(({ material: mat }, index) =>
          mat
            ? `<instance_material symbol="${symbolOf(index)}" target="#${material(mat)}">${uvInput}</instance_material>`
            : [],
        );
      out += `<instance_geometry url="#${geometry(geos, n.name)}">`;
      if (bound.length) out += `<bind_material><technique_common>${bound.join('')}</technique_common></bind_material>`;
      out += '</instance_geometry>';
    }
    return `${out}${n.children.map(node).join('')}</node>`;
  };
  const scene = roots.map(node).join('\n');

  const date = new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    library = (name: string, items: string[]) =>
      items.length ? `<library_${name}>\n${items.join('\n')}\n</library_${name}>\n` : '',
    imageItems = [...images].map(([file, id]) => `<image id="${id}"><init_from>${file}</init_from></image>`);
  const dae =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">\n' +
    `<asset><contributor><authoring_tool>Margo Engine exporters</authoring_tool></contributor><created>${date}</created>` +
    `<modified>${date}</modified><unit name="meter" meter="1"/><up_axis>Y_UP</up_axis></asset>\n` +
    library('images', imageItems) +
    library('effects', effects) +
    library('materials', materials) +
    library('geometries', geometries) +
    `<library_visual_scenes>\n<visual_scene id="scene">\n${scene}\n</visual_scene>\n</library_visual_scenes>\n` +
    '<scene><instance_visual_scene url="#scene"/></scene>\n</COLLADA>\n';
  return { dae, textures: files.files };
}
