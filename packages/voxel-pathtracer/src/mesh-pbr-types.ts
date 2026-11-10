import type { TraceVec3 } from '@margoengine/voxel-pathtracer';
import type { MeshTraceScene, TraceTriangleMesh } from './mesh.js';

/** An owned RGBA8 image and its glTF sampling state. */
export interface TracePBRTexture {
  /** Positive integer image width. */
  width: number;
  /** Positive integer image height. */
  height: number;
  /** Unpremultiplied RGBA8 pixels in row order. */
  data: Uint8Array | Uint8ClampedArray;
  /** Coordinate set, 0 through 3. Default 0. */
  texCoord?: number;
  /** Horizontal address mode. Default repeat. */
  wrapS?: 'repeat' | 'mirror' | 'clamp';
  /** Vertical address mode. Default repeat. */
  wrapT?: 'repeat' | 'mirror' | 'clamp';
  /** Spatial reconstruction. Default linear. */
  filter?: 'nearest' | 'linear';
  /** UV affine rows [a,b,tx,c,d,ty]. Default identity. */
  transform?: readonly number[];
}

/** glTF metallic-roughness surface properties for a traced palette material. */
export interface TracePBRMaterial {
  /** A positive integer mesh material id. Independent of the voxel palette. */
  id: number;
  /** Linear RGBA multiplier. Default [1,1,1,1]. */
  baseColorFactor?: readonly [number, number, number, number];
  /** Linear RGB emission. Default [0,0,0]. */
  emissiveFactor?: TraceVec3;
  /** Linear multiplier of emissiveFactor. Default 1. */
  emissiveStrength?: number;
  /** Metal lobe share. Default 1 as in glTF. */
  metallicFactor?: number;
  /** Perceptual roughness. Default 1. */
  roughnessFactor?: number;
  /** sRGB base colour; alpha is linear coverage. */
  baseColorTexture?: TracePBRTexture;
  /** Linear roughness in green and metallic in blue. */
  metallicRoughnessTexture?: TracePBRTexture;
  /** Linear tangent-space XYZ, mapped from [0,1] to [-1,1]. */
  normalTexture?: TracePBRTexture;
  /** Tangent-space XY scale. Default 1. */
  normalScale?: number;
  /** sRGB emissive colour. */
  emissiveTexture?: TracePBRTexture;
  /** Clearcoat layer intensity. Default 0. */
  clearcoatFactor?: number;
  /** Clearcoat perceptual roughness. Default 0. */
  clearcoatRoughnessFactor?: number;
  /** Linear clearcoat intensity in red. */
  clearcoatTexture?: TracePBRTexture;
  /** Linear clearcoat roughness in green. */
  clearcoatRoughnessTexture?: TracePBRTexture;
  /** Independent tangent-space clearcoat normal. */
  clearcoatNormalTexture?: TracePBRTexture;
  /** Clearcoat tangent-space XY scale. Default 1. */
  clearcoatNormalScale?: number;
  /** Linear sheen RGB. Default [0,0,0]. */
  sheenColorFactor?: TraceVec3;
  /** Sheen perceptual roughness. Default 0. */
  sheenRoughnessFactor?: number;
  /** sRGB sheen color. */
  sheenColorTexture?: TracePBRTexture;
  /** Linear sheen roughness in alpha. */
  sheenRoughnessTexture?: TracePBRTexture;
  /** Dielectric specular strength. Default 1. */
  specularFactor?: number;
  /** Linear dielectric F0 multiplier, clamped after multiplying 0.04. Default [1,1,1]. */
  specularColorFactor?: TraceVec3;
  /** Linear dielectric specular strength in alpha. */
  specularTexture?: TracePBRTexture;
  /** sRGB dielectric F0 multiplier. */
  specularColorTexture?: TracePBRTexture;
  /** Thin-film Fresnel blend. Default 0. */
  iridescenceFactor?: number;
  /** Thin-film index of refraction. Default 1.3. */
  iridescenceIor?: number;
  /** Minimum film thickness in nanometers. Default 100. */
  iridescenceThicknessMinimum?: number;
  /** Maximum film thickness in nanometers. Default 400. */
  iridescenceThicknessMaximum?: number;
  /** Linear thin-film blend in red. */
  iridescenceTexture?: TracePBRTexture;
  /** Linear thickness interpolation in green; without a texture maximum is used. */
  iridescenceThicknessTexture?: TracePBRTexture;
  /** OPAQUE or binary MASK coverage. Default OPAQUE. */
  alphaMode?: 'OPAQUE' | 'MASK';
  /** MASK coverage threshold. Default 0.5. */
  alphaCutoff?: number;
  /** Trace both geometric sides. Default false. */
  doubleSided?: boolean;
}

/** Mesh attributes retained by the optional PBR entry. */
export interface TracePBRMesh extends TraceTriangleMesh {
  /** An id in pbrMaterials. Independent of the voxel palette. */
  material: number;
  /** Four optional UV pair arrays. Set 0 defaults to uvs. */
  uvSets?: readonly (Float32Array | undefined)[];
  /** Optional xyzw tangent per position, including handedness. */
  tangents?: Float32Array;
  /** Optional linear RGBA vertex colour per position. Default white. */
  colors?: Float32Array;
}

/** Mixed scene with full mesh material channels. */
export interface PBRMeshTraceScene extends MeshTraceScene {
  /** Indexed geometry, with optional PBR vertex channels. */
  meshes: readonly TracePBRMesh[];
  /** Mesh materials, matched by id. Every mesh must name one. */
  pbrMaterials: readonly TracePBRMaterial[];
}
