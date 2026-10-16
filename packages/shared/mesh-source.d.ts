import type {Geometry,Mesh as PublicMesh} from '@margoengine/core';
import type {Mesh,PassContext} from '@margoengine/core/extension';
import type {PBRSource,PBRSourcePrimitive} from './pbr-source.js';
type Context=Extract<PassContext,{backend:'webgpu'}>;
export type MeshDeformationContext=Pick<Context,'backend'|'device'|'encoder'>;
export interface MeshDraw {
 readonly primitive?:object;
 readonly node:Mesh;readonly vertex:GPUBuffer;readonly index:GPUBuffer;readonly count:number;readonly stride:80;
 readonly alphaTexture?:GPUTextureView;readonly alphaSampler?:GPUSampler;readonly alpha?:number;readonly cutoff?:number;
 readonly texCoord?:0|1;readonly alphaTransform?:Float32Array;readonly doubleSided?:boolean;
}
export interface MeshPose {node:Mesh;vertices:Float32Array;indices:Uint32Array;doubleSided:boolean;matrix:Float32Array}
export interface MeshSourceOwner extends PBRSource {
 readonly disposed:boolean;
 readonly pickingPrimitives:readonly MeshDraw[];
 readonly shadowPrimitives:readonly (Omit<MeshDraw,'stride'|'texCoord'> & {stride:number;texCoord?:number})[];
 prepareDeformation?: (context:MeshDeformationContext)=>void;
 readPickingGeometry():Promise<readonly MeshPose[]>;
 createRenderer(device:GPUDevice):{prepare(context:MeshDeformationContext):void;draw(context:Context,pass:GPURenderPassEncoder,view:ArrayLike<number>):void;dispose():void};
 draw(context:Context,mode:'beauty'|'gbuffer'|'ambient',color:GPUTextureView,depth:GPUTextureView,phase?:'all'|'opaque'|'blend'):void;
}
export interface MeshSource {
 readonly model:MeshSourceOwner;readonly node:Mesh;
 readonly primitives:readonly PBRSourcePrimitive[];readonly stride:80;
 readonly skinned:boolean;readonly morphed:boolean;
 /** Bind-pose local AABB, xyz minimum followed by xyz maximum. */
 readonly bounds:Float32Array;
 /** Borrowed live draw buffers, including current deformation after animation. */
 readonly draws:readonly MeshDraw[];
 readonly shadowPrimitives:MeshSourceOwner['shadowPrimitives'];
 prepareDeformation(context:MeshDeformationContext):void;
 readPickingGeometry():Promise<readonly MeshPose[]>;
}
export function setMeshSource(mesh:PublicMesh,source:MeshSource):void;
export function clearMeshSource(mesh:PublicMesh):void;
export function meshTriangles(mesh:PublicMesh|null|undefined):{kind:'core';geometry:Geometry}|{kind:'pbr';source:MeshSource}|null;
