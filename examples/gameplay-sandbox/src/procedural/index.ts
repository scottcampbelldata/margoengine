import {PbrMaterial, type EngineKernel} from '@margoengine/core';
import {pbrVertexStream, footprintRadius, boxGeometry, computeTangents, type GeometryData} from '@margoengine/geometry';
import {generateCabinMesh, generateTreeMesh, generateShrubMesh, generateRockMesh, generateFernMesh, contactAO, radialAO, type HeightField} from '@margoengine/procedural';
import {PlacementLayout, ScatterInstances, instanceTransforms, groundTransforms, type ScatterBatch, type GroundBounds, type GroundPlacement} from '@margoengine/scatter';
import type {Shadows} from '@margoengine/shadows';
import {CABIN_POSITION, MATERIALS} from './meshes.ts';
import {SHRUB_CANDIDATES, FERN_CANDIDATES, ROCK_CANDIDATES, CABIN_EXCLUSIONS, TREE_POSITIONS} from './placement.ts';

export function createProceduralSettlement(engine: EngineKernel, shadows: Shadows, height: HeightField) {
  const exclusions: GroundBounds[] = [];
  const porchLightPosition: [number,number,number] = [0,0,0];
  const scatter = ScatterInstances.attach(engine, () => {
    const batches: ScatterBatch[] = [];
    const add = (name: string, data: GeometryData, transforms: Float32Array, material: keyof typeof MATERIALS, occlusion?: (x: number, y: number, z: number) => number, doubleSided = false) => batches.push({name, wind: material==='bark'||material==='pine'||material==='foliage' ? [1,0.35,0.045] : undefined, vertices: pbrVertexStream(data,occlusion), indices: data.indices, transforms, material: new PbrMaterial({...MATERIALS[material],doubleSided})});
    const cabin = generateCabinMesh(height,CABIN_POSITION), [cx,cz] = CABIN_POSITION;
    porchLightPosition[0]=cx+0.9;porchLightPosition[1]=cabin.floor+2.35;porchLightPosition[2]=cz+5.3;
    const foundation = instanceTransforms([[cx,cabin.floor,cz,1,0]]);
    const groundContact = (x: number, y: number, z: number) => contactAO(y+cabin.floor,height(cx+x,cz+z));
    add('Cabin cedar siding and recessed frames',cabin.siding,foundation,'siding',(x,y,z) => groundContact(x,y,z)*(y>=2.7&&y<=3 ? 0.35+0.65*(3-y)/0.3 : 1));
    add('Cabin 35 degree slate roof',cabin.roof,foundation,'roof');
    add('Cabin terrain-sunk stone foundation and porch',cabin.foundation,foundation,'foundation',groundContact);
    add('Cabin recessed glass panes',cabin.glass,foundation,'glass');
    batches[batches.length-1].emissive=[3,2.16,0.9];
    add('Warm porch lantern',computeTangents(boxGeometry(0.12,0.22,0.12)),instanceTransforms([[...porchLightPosition,1,0]]),'glass');
    batches[batches.length-1].emissive=[3,2.4,1.2];
    for (let variant = 0; variant < 2; variant++) {
      const kind = variant ? 'broadleaf' : 'conifer', tree = generateTreeMesh(kind), placements: GroundPlacement[] = [];
      for (let i = variant; i < TREE_POSITIONS.length; i += 2) {
        const [x,z] = TREE_POSITIONS[i]; placements.push([x,z,0.9+(i%3)*0.1,i*2.399963]);
      }
      const transforms = groundTransforms(placements,height,-0.2);
      add(kind+' trunks and branches',tree.trunk,transforms,'bark',(_x,y) => contactAO(y,0.2));
      add(kind+' smooth canopy',tree.canopy,transforms,variant ? 'foliage' : 'pine',(x,y,z) => radialAO(x,y,z,tree.center,tree.radius));
    }
    const shrubs = generateShrubMesh(), fern = generateFernMesh(), rock = generateRockMesh();
    const shrubRadius = footprintRadius(shrubs), fernRadius = footprintRadius(fern), rockRadius = footprintRadius(rock);
    const layout = new PlacementLayout(CABIN_EXCLUSIONS);
    const rocks = layout.place(ROCK_CANDIDATES,rockRadius), ferns = layout.place(FERN_CANDIDATES,fernRadius), bushes = layout.place(SHRUB_CANDIDATES,shrubRadius);
    exclusions.length = 0;
    exclusions.push(...layout.exclusions);
    add('Spaced perimeter and rock-base shrubs',shrubs,groundTransforms(bushes,height,-0.08),'foliage',(_x,y) => contactAO(y,0.08));
    add('Cabin and tree-root fern crowns',fern,groundTransforms(ferns,height,-0.08),'foliage',(_x,y) => contactAO(y,0.08),true);
    add('Coastal fieldstones clear of foundations',rock,groundTransforms(rocks,height,-0.18),'foundation',(_x,y) => contactAO(y,0.2));
    return batches;
  });
  shadows.add(scatter); return {scatter, exclusions, porchLightPosition};
}
