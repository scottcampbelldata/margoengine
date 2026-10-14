import {LinearToSRGB as toSrgb} from '@margoengine/math/color';
// Wavefront OBJ writer: the Margo Engine counterpart of Three.js OBJExporter, plus an optional MTL file.
import {collect, drawables, num, toWorld, token, type ExportSource, type Mat, type SceneOptions} from './scene.js';

export interface OBJOptions extends SceneOptions {
  /** Also write an MTL file and `usemtl` lines. Default false. */
  materials?: boolean;
  /** File name written in `mtllib`. Default 'scene.mtl'. */
  mtlName?: string;
  /** Append sRGB vertex colors to `v` lines (a common extension) when geometry has colors. Default false. */
  colors?: boolean;
}

export interface OBJResult {
  obj: string;
  /** The MTL text when `materials` is true, else null. */
  mtl: string|null;
}

/** Exports world-space OBJ with one group per mesh, normals, UVs when present, and 1-based indices. */
export function exportOBJ(source: ExportSource, options: OBJOptions = {}): OBJResult {
  const withMaterials = options.materials ?? false, mtlName = options.mtlName ?? 'scene.mtl', colors = options.colors ?? false;
  if (typeof withMaterials !== 'boolean' || typeof colors !== 'boolean') throw new TypeError('materials and colors must be boolean');
  if (typeof mtlName !== 'string' || !/^[^\s#]+$/.test(mtlName)) throw new TypeError('mtlName must be a file name without spaces');
  const lines = ['# Margo Engine OBJ export'], mtl = ['# Margo Engine MTL export'], names = new Map<Mat, string>(), groups = new Set<string>();
  if (withMaterials) lines.push(`mtllib ${mtlName}`);
  let vertexBase = 1, uvBase = 1, index = 0;
  for (const item of drawables(collect(source, options))) {
    const {positions, normals, indices} = toWorld(item), geo = item.geometry, uvs = geo.uvs;
    let group = token(item.name, `mesh_${index}`);
    for (let n = 2; groups.has(group); n++) group = `${token(item.name, `mesh_${index}`)}_${n}`;
    groups.add(group); index++;
    lines.push(`g ${group}`);
    if (withMaterials && item.material) {
      let name = names.get(item.material);
      if (!name) {
        const base = token(item.material.name, `material_${names.size}`);
        name = base;
        for (let n = 2; [...names.values()].includes(name); n++) name = `${base}_${n}`;
        names.set(item.material, name);
        const m = item.material, kd = m.color.slice(0, 3).map(v => num(toSrgb(v)));
        mtl.push(`newmtl ${name}`, `Kd ${kd.join(' ')}`, 'Ka 0 0 0', 'Ks 0 0 0', `Ke ${m.emissive.map(v => num(toSrgb(v))).join(' ')}`, `Pr ${num(m.roughness)}`, `Pm ${num(m.metalness)}`, `d ${num(m.color[3])}`, 'illum 2', '');
      }
      lines.push(`usemtl ${name}`);
    }
    for (let i = 0; i < geo.count; i++) {
      let line = `v ${num(positions[i*3])} ${num(positions[i*3+1])} ${num(positions[i*3+2])}`;
      if (colors && geo.colors) {const c = i*geo.colorSize; line += ` ${num(toSrgb(geo.colors[c]))} ${num(toSrgb(geo.colors[c+1]))} ${num(toSrgb(geo.colors[c+2]))}`;}
      lines.push(line);
    }
    // OBJ texture coordinates have v up; glTF and Margo Engine have v down.
    if (uvs) for (let i = 0; i < geo.count; i++) lines.push(`vt ${num(uvs[i*2])} ${num(1-uvs[i*2+1])}`);
    for (let i = 0; i < geo.count; i++) lines.push(`vn ${num(normals[i*3])} ${num(normals[i*3+1])} ${num(normals[i*3+2])}`);
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i]+vertexBase, b = indices[i+1]+vertexBase, c = indices[i+2]+vertexBase, t = uvBase-vertexBase;
      lines.push(uvs ? `f ${a}/${a+t}/${a} ${b}/${b+t}/${b} ${c}/${c+t}/${c}` : `f ${a}//${a} ${b}//${b} ${c}//${c}`);
    }
    vertexBase += geo.count;
    if (uvs) uvBase += geo.count;
  }
  lines.push('');
  return {obj: lines.join('\n'), mtl: withMaterials ? mtl.join('\n') : null};
}
