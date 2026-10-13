import {meshRuntime} from '@margoengine/core/extension';
import type {Mesh as MeshHandle, Vec3} from '@margoengine/core';

export interface Anchor {point:Vec3;node?:MeshHandle}
export function worldAnchor(anchor:Anchor):Vec3 {const p=anchor.point;if(p.length!==3||!p.every(v=>typeof v==='number'&&Number.isFinite(Math.fround(v))))throw new TypeError('Invalid annotation anchor');if(!anchor.node)return p;anchor.node.check();const m=meshRuntime(anchor.node).matrix;return [m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12],m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13],m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14]];}
