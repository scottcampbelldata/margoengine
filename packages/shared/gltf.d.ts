/** Structural glTF 2.0 data consumed by the optional loaders. Runtime validation stays at each use site. */
export interface GLTFProperty<E extends Record<string, unknown> = GLTFExtensions> {
  name?: string;
  extras?: unknown;
  extensions?: E;
  [key: string]: unknown;
}

/** Known extension payloads retain their schema; application-specific extensions remain unknown. */
export interface GLTFExtensions {
  [key: string]: unknown;
  KHR_draco_mesh_compression?: { bufferView: number; attributes: Record<string, number> };
  EXT_meshopt_compression?: GLTFMeshopt;
  KHR_meshopt_compression?: GLTFMeshopt;
  KHR_texture_basisu?: { source: number };
  EXT_texture_webp?: { source: number };
  EXT_texture_avif?: { source: number };
  KHR_texture_transform?: GLTFTextureTransform;
  EXT_mesh_gpu_instancing?: GLTFInstancing;
  KHR_lights_punctual?: { light?: number; lights?: GLTFLightDefinition[] };
  KHR_materials_variants?: { variants?: { name: string }[]; mappings?: { material: number; variants: number[] }[] };
  KHR_materials_unlit?: object;
  KHR_materials_emissive_strength?: { emissiveStrength?: number };
  KHR_materials_ior?: { ior?: number };
  KHR_materials_dispersion?: { dispersion?: number };
  KHR_materials_clearcoat?: {
    clearcoatFactor?: number;
    clearcoatRoughnessFactor?: number;
    clearcoatTexture?: GLTFTextureInfo;
    clearcoatRoughnessTexture?: GLTFTextureInfo;
    clearcoatNormalTexture?: GLTFTextureInfo;
  };
  KHR_materials_transmission?: { transmissionFactor?: number; transmissionTexture?: GLTFTextureInfo };
  KHR_materials_volume?: {
    thicknessFactor?: number;
    thicknessTexture?: GLTFTextureInfo;
    attenuationDistance?: number;
    attenuationColor?: number[];
  };
  KHR_materials_sheen?: {
    sheenColorFactor?: number[];
    sheenRoughnessFactor?: number;
    sheenColorTexture?: GLTFTextureInfo;
    sheenRoughnessTexture?: GLTFTextureInfo;
  };
  KHR_materials_specular?: {
    specularFactor?: number;
    specularColorFactor?: number[];
    specularTexture?: GLTFTextureInfo;
    specularColorTexture?: GLTFTextureInfo;
  };
  KHR_materials_iridescence?: {
    iridescenceFactor?: number;
    iridescenceIor?: number;
    iridescenceThicknessMinimum?: number;
    iridescenceThicknessMaximum?: number;
    iridescenceTexture?: GLTFTextureInfo;
    iridescenceThicknessTexture?: GLTFTextureInfo;
  };
  KHR_materials_anisotropy?: {
    anisotropyStrength?: number;
    anisotropyRotation?: number;
    anisotropyTexture?: GLTFTextureInfo;
  };
  KHR_materials_diffuse_transmission?: {
    diffuseTransmissionFactor?: number;
    diffuseTransmissionColorFactor?: number[];
    diffuseTransmissionTexture?: GLTFTextureInfo;
    diffuseTransmissionColorTexture?: GLTFTextureInfo;
  };
}
export interface GLTFMeshopt {
  fallback?: boolean;
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride: number;
  count: number;
  mode: string;
  filter?: string;
}
export interface GLTFInstancing {
  attributes: Record<string, number>;
}
export interface GLTFTextureTransform {
  offset?: readonly [number, number];
  rotation?: number;
  scale?: readonly [number, number];
  texCoord?: number;
}
export interface GLTFTextureInfo extends GLTFProperty {
  index: number;
  texCoord?: number;
  scale?: number;
  strength?: number;
}
export interface GLTFBufferExtensions {
  [key: string]: unknown;
  EXT_meshopt_compression?: { fallback?: boolean };
}
export interface GLTFBuffer extends GLTFProperty<GLTFBufferExtensions> {
  byteLength: number;
  uri?: string;
}
export interface GLTFBufferView extends GLTFProperty {
  buffer: number;
  byteLength: number;
  byteOffset?: number;
  byteStride?: number;
  target?: number;
}
export interface GLTFAccessor extends GLTFProperty {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  normalized?: boolean;
  min?: number[];
  max?: number[];
  sparse?: {
    count: number;
    indices: { bufferView: number; byteOffset?: number; componentType: number };
    values: { bufferView: number; byteOffset?: number };
  };
}
export interface GLTFPrimitive extends GLTFProperty {
  /** Absent for engine-owned prepared geometry whose vertices are supplied separately. */
  attributes?: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
  targets?: Record<string, number>[];
}
export interface GLTFMesh extends GLTFProperty {
  primitives: GLTFPrimitive[];
  weights?: number[];
}
export interface GLTFNode extends GLTFProperty {
  mesh?: number;
  skin?: number;
  camera?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  weights?: number[];
}
export interface GLTFMaterial extends GLTFProperty {
  pbrMetallicRoughness?: {
    baseColorFactor?: number[];
    metallicFactor?: number;
    roughnessFactor?: number;
    baseColorTexture?: GLTFTextureInfo;
    metallicRoughnessTexture?: GLTFTextureInfo;
  };
  normalTexture?: GLTFTextureInfo;
  occlusionTexture?: GLTFTextureInfo;
  emissiveTexture?: GLTFTextureInfo;
  emissiveFactor?: number[];
  alphaMode?: string;
  alphaCutoff?: number;
  doubleSided?: boolean;
}
export interface GLTFTexture extends GLTFProperty {
  source?: number;
  sampler?: number;
}
export interface GLTFImageDefinition extends GLTFProperty {
  uri?: string;
  mimeType?: string;
  bufferView?: number;
}
export interface GLTFSampler extends GLTFProperty {
  wrapS?: number;
  wrapT?: number;
  magFilter?: number;
  minFilter?: number;
}
export interface GLTFSkin extends GLTFProperty {
  joints: number[];
  inverseBindMatrices?: number;
  skeleton?: number;
}
export interface GLTFAnimation extends GLTFProperty {
  samplers: { input: number; output: number; interpolation?: string }[];
  channels: { sampler: number; target: { node?: number; path: string } }[];
}
export interface GLTFLightDefinition extends GLTFProperty {
  type: 'directional' | 'point' | 'spot';
  color?: number[];
  intensity?: number;
  range?: number;
  spot?: { innerConeAngle?: number; outerConeAngle?: number };
}
export interface GLTFCameraDefinition extends GLTFProperty {
  type: 'perspective' | 'orthographic';
  perspective?: { yfov: number; znear: number; zfar?: number; aspectRatio?: number };
  orthographic?: { xmag: number; ymag: number; znear: number; zfar: number };
}
export interface GLTFDocument extends GLTFProperty {
  asset?: { version: string; generator?: string; [key: string]: unknown };
  buffers?: GLTFBuffer[];
  bufferViews?: GLTFBufferView[];
  accessors?: GLTFAccessor[];
  meshes?: GLTFMesh[];
  nodes?: GLTFNode[];
  scenes?: (GLTFProperty & { nodes?: number[] })[];
  scene?: number;
  materials?: GLTFMaterial[];
  textures?: GLTFTexture[];
  images?: GLTFImageDefinition[];
  samplers?: GLTFSampler[];
  skins?: GLTFSkin[];
  animations?: GLTFAnimation[];
  cameras?: GLTFCameraDefinition[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
}
