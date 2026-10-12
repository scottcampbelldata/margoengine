'use client';
import { useRef } from 'react';
import { Canvas, Mesh, BoxGeometry, PbrMaterial, useFrame, type MeshRef } from '@margoengine/react';
function Cube(){const mesh=useRef<MeshRef>(null);useFrame((_,delta)=>{if(mesh.current)mesh.current.rotation.y+=delta;});return <Mesh ref={mesh}><BoxGeometry/><PbrMaterial color="#84d6bd" roughness={0.3}/></Mesh>;}
export default function Page(){return <main><h1 style={{padding:'24px 32px'}}>Margo Engine / Next.js</h1><Canvas style={{height:'70vh'}} label="Rotating 3D cube"><Cube/></Canvas></main>;}
