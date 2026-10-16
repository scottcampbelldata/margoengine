import type {MaterialExtensionTexture} from '@margoengine/gltf-pro';

/** A linear RGBA constant, stored in the optional material factors block. */
export interface ColorNode {type:'color';value:readonly [number,number,number,number]}
/** A scalar constant, stored in the optional material factors block. */
export interface ScalarNode {type:'scalar';value:number}
/** Sample a caller-owned 2D texture using one of the existing vertex UV sets. */
export interface TextureNode {type:'texture';texture:MaterialExtensionTexture;texCoord?:0|1}
/** Component-wise addition. A scalar input broadcasts to the other input's width. */
export interface AddNode {type:'add';a:ValueNode;b:ValueNode}
/** Component-wise multiplication. A scalar input broadcasts to the other input's width. */
export interface MulNode {type:'mul';a:ValueNode;b:ValueNode}
/** Component-wise interpolation; factor is scalar or has the result's width. */
export interface MixNode {type:'mix';a:ValueNode;b:ValueNode;factor:ValueNode}
export type ValueNode=ColorNode|ScalarNode|TextureNode|AddNode|MulNode|MixNode;

/** Decode a vec4 input as a tangent-space normal in the existing vertex frame. */
export interface NormalMapNode {
  type:'normalMap';
  texture:ValueNode;
  /** Must produce an f32; scalar arithmetic is accepted. */
  scale?:ValueNode;
  texCoord?:0|1;
}
/** Scalar inputs use their value; vec4 inputs use roughness G and metal B. */
export interface MetalRoughNode {
  type:'metalRough';
  roughness?:ValueNode;
  metal?:ValueNode;
  /** Packed roughness G and metal B, multiplied by any supplied factors. */
  texture?:ValueNode;
}
/** The shared glTF clearcoat lobe, with optional independent coat normal. */
export interface ClearcoatNode {
  type:'clearcoat';
  /** A vec4 factor input uses R. Missing factor means 0. */
  factor?:ValueNode;
  /** A vec4 roughness input uses G. Missing roughness means 0. */
  roughness?:ValueNode;
  normal?:NormalMapNode;
}
export interface NodeVolume {
  /** A vec4 thickness input uses G. Missing thickness means 0. */
  thickness?:ValueNode;
  /** Linear attenuation RGB from a vec4 input; missing color means white. */
  attenuationColor?:ValueNode;
  /** A missing distance or Infinity leaves transmitted color unattenuated. */
  attenuationDistance?:number;
}
/** The shared screen-space transmission and Beer-law volume implementation. */
export interface TransmissionNode {
  type:'transmission';
  /** A vec4 factor input uses R. Missing factor means 0. */
  factor?:ValueNode;
  /** Missing IOR means 1.5. IOR 1 preserves the opaque snapshot's pixel. */
  ior?:ValueNode;
  volume?:NodeVolume;
}
/** The graph's required, unique output. Color enters the existing PBR surface. */
export interface EmitNode {
  type:'emit';
  color:ValueNode;
  normal?:NormalMapNode;
  metalRough?:MetalRoughNode;
  clearcoat?:ClearcoatNode;
  transmission?:TransmissionNode;
}
export type MaterialNode=ValueNode|NormalMapNode|MetalRoughNode|ClearcoatNode|TransmissionNode|EmitNode;

/** Object references connect nodes; nested nodes need not also appear in nodes. */
export interface MaterialGraph {nodes:readonly MaterialNode[]}
/** GPU resources remain caller-owned. Installation supplies its own scene capture. */
export interface NodeMaterialOptions {opaqueColor?:GPUTextureView}
