import { Geometry, PbrMaterial } from '@margoengine/core';
import { Terrain } from '@margoengine/terrain';
import { Imposter } from '@margoengine/lod';
import { ImposterScatter } from '@margoengine/scatter/imposter';
import { columns, origin, extent, noise } from './relief.mjs';

const textures = [
  { base: [88,101,77], color: [35,45,24], palette: [13,11,8] },
  { base: [105,109,115], color: [66,64,64], palette: [20,14,8] },
  { base: [110,94,79], color: [52,46,38], palette: [14,10,9] },
  { base: [181,195,204], color: [49,50,45], palette: [5,3,4] },
];

function makeLayer(spec, seed, size) {
  const data = new Uint8Array(size * size * 4);
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      const t = 2 * Math.PI * x / size, s = 2 * Math.PI * z / size;
      const u = Math.cos(t) + .4 * Math.sin(3*t) + .14 * Math.cos(s);
      const v = Math.sin(s) + .3 * Math.cos(2*s) + .22 * Math.sin(t);
      const shape = .58 * noise(u*3, v*3, seed) + .25 * noise(u*9,v*8,seed+4)
        + .17 * noise(u*31,v*28,seed+9);
      const bands = Math.sin(6*Math.sin(s) + 3*Math.cos(t)) * .5;
      const offset = (z * size + x) * 4;
      for (let c = 0; c < 3; c++) data[offset + c] = spec.base[c] + shape * spec.color[c] + bands * spec.palette[c];
      data[offset + 3] = 255;
    }
  }
  return data;
}

function layersOn(device) {
  const count = 7, size = 64;
  const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
  const layers = device.createTexture({ size: [size,size,textures.length], mipLevelCount: count, format: 'rgba8unorm-srgb', usage });
  for (const [index, layer] of textures.entries()) {
    let source = makeLayer(layer, index * 19 + 180, size);
    for (let mip = 0; mip < count; mip++) {
      const n = size >> mip;
      device.queue.writeTexture({texture: layers, mipLevel: mip, origin: [0,0,index]}, source,
        {bytesPerRow: n * 4, rowsPerImage: n}, [n,n,1]);
      if (n < 2) break;
      const half = n >> 1;
      const next = new Uint8Array(half * half * 4);
      for (let y = 0; y < half; y++) {
        for (let x = 0; x < half; x++) {
          const row = 4*(x*2 + y*2*n), offset = 4*(x+y*half);
          for (let c = 0; c < 3; c++) {
            next[offset+c] = Math.round((source[row+c] + source[row+4+c] + source[row+n*4+c] + source[row+n*4+4+c]) / 4);
          }
          next[offset+3] = 255;
        }
      }
      source = next;
    }
  }
  return layers;
}

function conifer(sides, levels) {
  const positions = [], normals = [], triangles = [];
  const wire = (y, radius, top, flare, seed) => {
    const start = positions.length / 3;
    for (let row = 0; row < 3; row++) {
      const elevation = [y,y + .40 * (top-y),top][row];
      const taper = [1,.73,flare][row];
      for (let n = 0; n < sides; n++) {
        const angle = 2*Math.PI*n/sides + seed * .81;
        const radial = radius * taper * (1 + .13*Math.sin(seed*7 + n*4) + .07 * Math.cos(n*3));
        const sway = -.15 * elevation / 19;
        positions.push(Math.cos(angle)*radial + sway, elevation + (row ? 0 : .33 * Math.sin(n*2.7 + seed)), Math.sin(angle)*radial);
        normals.push(Math.cos(angle)*.80, .60, Math.sin(angle)*.80);
      }
    }
    for (let row = 0; row < 2; row++) {
      for (let n = 0; n < sides; n++) {
        const a = start + row*sides+n, b = start+row*sides+(n+1)%sides;
        triangles.push(a,a+sides,b,b,a+sides,b+sides);
      }
    }
  };
  wire(0,.26,12.4,.23,0);
  for (let n = 0; n < levels; n++) {
    const fraction = n / (levels - 1);
    wire(1.9 + fraction * 14.5, 3.2 * (1 - fraction * .86), 6.5 + fraction * 13.8,
      n === levels - 1 ? .04 : .15, n+1);
  }
  return new Geometry(positions, normals, triangles);
}

export function buildLandscape(engine, heights) {
  const terrain = Terrain.attach(engine, {
    origin, size: extent, heightScale: 1, cellSize: 5, resolution: 144, levels: 8,
    layers: [
      { height: [25,1750], slope: [0,.52], scale: .013, bump: .12, macro: .43 },
      { height: [1350,6200], slope: [.16,1], scale: .012, bump: .27, macro: .65 },
      { height: [1350,2850], slope: [0,.29], scale: .018, bump: .16, macro: .39 },
      { height: [2930,6200], slope: [0,.28], scale: .013, bump: .10, macro: .17 },
    ],
    textures: device => {
      const heightmap = device.createTexture({ size: [columns,columns], format: 'r32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      device.queue.writeTexture({texture: heightmap}, heights, {bytesPerRow: columns * 4}, [columns,columns]);
      return {heightmap, layers: layersOn(device)};
    },
  });
  const material = new PbrMaterial({color: '#385840', roughness: .91, metalness: 0});
  const near = conifer(9,8), mid = conifer(6,5), far = conifer(5,4);
  const imposter = Imposter.bake(engine, far, {material, frames: 5, frameSize: 32});
  const bounds = [origin[0],origin[1],origin[0]+extent[0],origin[1]+extent[1]];
  ImposterScatter.attach(engine, [near,mid,far], {
    imposter, material, count: 45000, seed: 831, area: [21500,14200], center: [250,0,1250],
    heightmap: () => terrain.heightmap, bounds, minHeight: 745, maxHeight: 1890,
    maxSlope: 36, density: .93, scale: [.59,1.55], sink: 1.5, lod: [850,2700,13100],
    lodFade: 105, edgeShrink: 230,
  });
  return { terrain, imposter };
}