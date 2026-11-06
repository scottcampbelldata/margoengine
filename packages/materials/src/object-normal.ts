// Object-space normal maps: the texel is the normal itself in the mesh's own axes, so no tangents are read. The vertex
// stage hands the fragment the matrix that takes mesh normals to world space, per instance: the cofactor matrix of the
// model matrix (the inverse transpose up to a positive scale), flat, as a rigid mesh's matrix is the same at every vertex.
import type { Material, MaterialFeature } from './built-material.js';

/** Options of `objectNormal()`. */
export interface ObjectNormalOptions {
  /**
   * The axis the baker called up. `'y'` (default) reads the map in the mesh's own axes; `'z'` reads a map baked in Z-up
   * axes (Blender, 3ds Max, most photogrammetry tools) on a mesh exported Y-up, as glTF is: x, y, z become x, z, -y.
   */
  up?: 'y' | 'z';
}
const line = 's.n=normalize(t*sampledNormal.x*f.factors.z+b*sampledNormal.y*f.factors.z+n*sampledNormal.z);',
  place = /let p=f\.model\*vec4f\([^;]*,1\);/,
  cached = new Map<string, string>();
function mapped(source: string, up: 'y' | 'z'): string {
  const id = up + source;
  let out = cached.get(id);
  if (out !== undefined) return out;
  const texel = up === 'z' ? 'sampledNormal.xzy*vec3f(1,1,-1)' : 'sampledNormal';
  out = source
    .replace(
      /(struct Out \{[^}]*?)\n\}/,
      '$1, @location(9) @interpolate(flat) margoObjectX:vec3f, @location(10) @interpolate(flat) margoObjectY:vec3f, @location(11) @interpolate(flat) margoObjectZ:vec3f\n}',
    )
    .replace(
      place,
      (head) =>
        // gltf-pro's instanced vertex stage turns this matrix into the instance's own.
        `${head}let margoObjectModel=f.model; let margoObjectSign=select(-1.0,1.0,dot(margoObjectModel[0].xyz,cross(margoObjectModel[1].xyz,margoObjectModel[2].xyz))>0);
  o.margoObjectX=cross(margoObjectModel[1].xyz,margoObjectModel[2].xyz)*margoObjectSign; o.margoObjectY=cross(margoObjectModel[2].xyz,margoObjectModel[0].xyz)*margoObjectSign; o.margoObjectZ=cross(margoObjectModel[0].xyz,margoObjectModel[1].xyz)*margoObjectSign;`,
    )
    .replaceAll(
      line,
      `s.n=normalize(mix(n,normalize(mat3x3f(i.margoObjectX,i.margoObjectY,i.margoObjectZ)*(${texel}))*select(-1.0,1.0,facing),f.factors.z));`,
    );
  if (!out.includes('o.margoObjectX=') || !out.includes('i.margoObjectX,'))
    throw new TypeError(
      'objectNormal needs the standard gltf-pro PBR shader; use matching gltf-pro and materials versions',
    );
  if (cached.size >= 64) cached.clear();
  cached.set(id, out);
  return out;
}
/**
 * Reads the material's `normalMap` as an object-space normal map (RGB is the normal in the mesh's own axes, 0.5 at
 * zero), the format bakers and photogrammetry tools emit for rigid props. The mesh needs no tangents. `normalScale` runs
 * from the vertex normal (0) to the map's (1). Assign it through `Material.features`.
 */
export function objectNormal(options: ObjectNormalOptions = {}): MaterialFeature {
  const { up = 'y' } = options;
  if (up !== 'y' && up !== 'z') throw new TypeError("objectNormal up must be 'y' or 'z'; pass the axis the baker used");
  return {
    name: 'objectNormal',
    shader: (source, _group, material: Material) => (material.normalMap ? mapped(source, up) : source),
  };
}
