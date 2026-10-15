import {Engine as Runtime} from './engine.js';
import type {EngineOptions} from './engine.js';
import type {Camera,Vec3} from './camera.js';
import type {Geometry,PbrMaterial} from './geometry.js';
export interface VectorRef {x:number;y:number;z:number;set(x:number,y:number,z:number):this;setAll(value:number):this}
export interface Mesh {
  name:string;visible:boolean;readonly position:VectorRef;readonly rotation:VectorRef;readonly scale:VectorRef;readonly geometry:Geometry|null;readonly material:PbrMaterial;
  check():void;setPosition(value:Vec3):this;setScale(value:Vec3):this;setRotation(value:Vec3):this;setQuaternion(value:readonly number[]):this;setParent(parent:Mesh|null):this;setGeometry(value:Geometry|null):this;setMaterial(value:PbrMaterial):this;dispose():void;
}
export interface EngineKernel {
  readonly canvas:HTMLCanvasElement;readonly camera:Camera;readonly backend:'webgpu'|'webgl2';readonly fallbackReason:string|null;readonly disposed:boolean;readonly stats:{visible:number;drawCalls:number};
  onError:(error:unknown)=>void;createMesh(parent?:Mesh|null):Mesh;pick(x:number,y:number):Promise<Mesh|null>;render(options?:{culling?:boolean;delta?:number}):void;start(options?:{culling?:boolean}):void;stop():void;dispose():void;rebootDevice():Promise<void>;
  use(plugin:EnginePlugin):this;hasPlugin(name:string):boolean;removePlugin(name:string):void;onFrame(callback:FrameCallback):()=>void;
}
export interface EnginePlugin {name:string;setup(engine:EngineKernel):void;onPreUpdate?(delta:number):void;onDeviceRestored?(engine:EngineKernel):void;dispose?():void}
export type FrameCallback=(engine:EngineKernel,delta:number)=>void;
export type Engine=EngineKernel;
export const Engine: {create(canvas:HTMLCanvasElement,options?:EngineOptions):Promise<EngineKernel>}=Runtime as unknown as typeof Engine;
export const EngineKernel=Engine;
