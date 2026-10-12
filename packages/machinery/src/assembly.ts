import {engineRuntime,meshRuntime} from '@margoengine/core/extension';
import type {EngineKernel,Mesh as MeshHandle} from '@margoengine/core';
import type {Engine,Mesh} from '@margoengine/core/extension';
export class AssemblyIndex {
  private readonly names=new Map<string,Set<Mesh>>();
  private readonly tags=new Map<string,Set<Mesh>>();
  private readonly engine:Engine;
  constructor(engine:EngineKernel){this.engine=engineRuntime(engine);this.refresh();}
  refresh():void {this.names.clear();for(const node of this.engine.meshes.values()){const group=this.names.get(node.name)??new Set<Mesh>();group.add(node);this.names.set(node.name,group);}for(const group of this.tags.values())for(const node of group)if(this.engine.meshes.get(node.id)!==node)group.delete(node);}
  tag(handle:MeshHandle,tag:string):void {const node=meshRuntime(handle);node.check();if(node.engine!==this.engine||typeof tag!=='string'||!tag||tag.length>256)throw new TypeError('Invalid assembly tag');const group=this.tags.get(tag)??new Set<Mesh>();group.add(node);this.tags.set(tag,group);}
  untag(node:MeshHandle,tag:string):void {this.tags.get(tag)?.delete(meshRuntime(node));}
  private within(node:Mesh,handle?:MeshHandle):boolean {const root=handle?meshRuntime(handle):undefined;if(this.engine.meshes.get(node.id)!==node)return false;if(!root)return true;root.check();if(root.engine!==this.engine)throw new TypeError('Assembly root belongs to another engine');for(let id=node.id,depth=0;id!==-1&&depth<64;id=this.engine.store.parents[id],depth++)if(id===root.id)return true;return false;}
  findChildrenByName(pattern:string,root?:MeshHandle):MeshHandle[] {if(typeof pattern!=='string'||pattern.length>256)throw new TypeError('Invalid name pattern');const expression=new RegExp('^'+pattern.split('*').map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')+'$'),found:Mesh[]=[];for(const [name,nodes] of this.names)if(expression.test(name))for(const node of nodes)if(this.within(node,root))found.push(node);return found;}
  findByTag(tag:string,root?:MeshHandle):MeshHandle[] {return [...(this.tags.get(tag)??[])].filter(node=>this.within(node,root));}
  setSubtreeVisible(handle:MeshHandle,visible:boolean):void {const root=meshRuntime(handle);root.check();if(root.engine!==this.engine)throw new TypeError('Assembly root belongs to another engine');root.visible=visible;}
}
