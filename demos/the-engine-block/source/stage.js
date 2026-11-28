import { Material, Texture, UnlitMaterial, createMesh } from '@margoengine/materials';
import { Lines, Line } from '@margoengine/lines';
import { featureEdges } from '@margoengine/lines/edges';
import { LabelRenderer } from '@margoengine/labels';
import { ViewCube } from '@margoengine/viewcube';
import { Selection } from '@margoengine/selection';
import { dimensions, boreChord, sectionLimit } from './dimensions.mjs';
import { makeSection } from './section.mjs';

function grain(seed, directional) {
  const side = 64;
  const data = new Uint8Array(side * side * 4);
  const noise = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let y = 0; y < side; y++) {
    const thread = noise();
    for (let x = 0; x < side; x++) {
      const index = (y * side + x) * 4;
      const value = 202 + 34 * noise() + (directional ? 15 * thread : 0);
      data.set([value, value, value, 255], index);
    }
  }
  return new Texture({ width: side, height: side, data, wrapS: 'repeat', wrapT: 'repeat' });
}

function polygon(width, depth, chamfer, y) {
  const a = width / 2, b = depth / 2, c = chamfer;
  return [[-a + c,y,b], [a-c,y,b], [a,y,b-c], [a,y,-b+c], [a-c,y,-b], [-a+c,y,-b], [-a,y,-b+c], [-a,y,b-c]];
}

function facet(geometry, a, b, c, d) {
  const { positions, normals, indices } = geometry;
  const u = b.map((value, i) => value - a[i]), v = c.map((value, i) => value - a[i]);
  const n = [u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
  const length = Math.hypot(...n);
  const unit = n.map(value => value / length);
  const first = positions.length / 3;
  positions.push(...a,...b,...c);
  normals.push(...unit,...unit,...unit);
  indices.push(first,first+1,first+2);
  if (d) {
    positions.push(...d);
    normals.push(...unit);
    indices.push(first,first+2,first+3);
  }
}

function plinth(profiles) {
  const geometry = { positions: [], normals: [], indices: [] };
  for (let row = 1; row < profiles.length; row++) {
    const bottom = polygon(...profiles[row - 1]), top = polygon(...profiles[row]);
    for (let i = 0; i < 8; i++) {
      const j = (i + 1) % 8;
      facet(geometry, bottom[i], bottom[j], top[j], top[i]);
    }
    if (row === profiles.length - 1) {
      for (let i = 1; i < 7; i++) facet(geometry, top[0], top[i], top[i + 1]);
    }
  }
  return geometry;
}

function buildStand(engine, lines) {
  const graphite = new Material({ color: '#283c3f', metalness: .24, roughness: .69 });
  const edge = new Material({ color: '#678480', metalness: .45, roughness: .42 });
  const darker = new Material({ color: '#14292d', metalness: .17, roughness: .68 });
  const parts = [
    plinth([[.486,.259,.025,.006],[.504,.278,.028,.014],[.504,.278,.028,.029],[.493,.265,.024,.035]]),
    plinth([[.504,.278,.028,.014],[.505,.279,.028,.018]]),
    plinth([[.455,.219,.018,.0345],[.455,.219,.018,.041],[.447,.212,.015,.0442]]),
  ];
  [graphite, edge, darker].forEach((material, i) => createMesh(engine, parts[i], material));

  const ticks = [];
  for (let i = -20; i <= 20; i++) {
    const x = i * .010;
    ticks.push(x,.0354,.126,x,.0354,i % 5 ? .120 : .114);
  }
  lines.add(new Line({ mode: 'segments', positions: ticks, width: .8, color: [ .49, .67, .63 ], opacity: .7 }));

  const shadow = { positions: [0,.002,0], normals: [0,1,0], colors: [0,0,0,.35], indices: [] };
  const rings = [
    [.205,.082,.32],[.257,.125,.22],[.308,.174,.07],[.39,.24,0],
  ];
  const samples = 48;
  for (const [x,z,alpha] of rings) {
    for (let i = 0; i < samples; i++) {
      const angle = -2 * Math.PI * i / samples;
      shadow.positions.push(Math.cos(angle) * x, .002, Math.sin(angle) * z);
      shadow.normals.push(0,1,0);
      shadow.colors.push(0,0,0,alpha);
    }
  }
  for (let i = 0; i < samples; i++) {
    const next = (i + 1) % samples;
    shadow.indices.push(0,1+i,1+next);
    for (let j = 1; j < rings.length; j++) {
      const from = 1 + (j - 1) * samples, to = from + samples;
      shadow.indices.push(from+i,to+i,to+next,from+i,to+next,from+next);
    }
  }
  createMesh(engine, shadow, new UnlitMaterial({ color: '#ffffff', transparent: true, depthWrite: false }));
}

export function createStage(engine, mesh) {
  engine.scene.background = '#23383d';
  engine.lighting.direction.set([-.27,.88,.61,3.1]);
  engine.lighting.radiance.set([1,.96,.89,.49]);
  engine.lighting.ambient.set([.64,.79,.87]);

  const castingGrain = grain(8514, false);
  const machiningGrain = grain(3185, true);
  const machined = { map: machiningGrain, triplanar: true, triplanarScale: 54 };
  const cast = { map: castingGrain, triplanar: true, triplanarScale: 17 };
  const accent = new Material({ color: '#e6914d', roughness: .58, metalness: .1, side: 'double' });
  const materials = [
    new Material({ color: '#64858a', roughness: .62, metalness: .23, ...cast }),
    new Material({ color: '#c2cbba', roughness: .29, metalness: .34, ...machined }),
    new Material({ color: '#57767b', roughness: .58, metalness: .16, ...cast }),
    new Material({ color: '#73918f', roughness: .35, metalness: .28, ...machined }),
    ...dimensions.centers.map(() => new Material({ color: '#8caeaa', roughness: .28, metalness: .37, ...machined })),
  ];
  const structure = { positions: mesh.positions, normals: mesh.normals };
  const body = mesh.groups.map((indices, i) => createMesh(engine, { ...structure, indices }, materials[i]));
  const lines = Lines.attach(engine);
  buildStand(engine, lines);
  const feature = lines.add(new Line({
    mode: 'segments',
    positions: featureEdges({ vertices: mesh.positions, indices: mesh.indices }, { stride: 3, angle: 50, boundary: false }),
    color: [.065,.13,.145], opacity: .70, width: .74,
  }));
  const outline = lines.add(new Line({ mode: 'segments', color: [.98,.68,.39], opacity: .85, width: 1.04, visible: false }));
  const dimension = lines.add(new Line({ mode: 'segments', color: [1,.79,.52], opacity: .97, width: 1.3, onTop: true, visible: false }));
  const labels = LabelRenderer.attach(engine, { zIndex: 2 });
  const tag = document.createElement('span');
  tag.className = 'measure-tag';
  const measure = labels.add(tag, { position: [0,0,0], visible: false });
  const selection = Selection.attach(engine, { width: 1.75, color: [1,.65,.28], algorithm: 'morphological' });

  const emptyCap = { positions: [0,0,0,.001,0,0,0,.001,0], normals: [0,0,1,0,0,1,0,0,1], indices: [0,1,2] };
  const sectionCap = createMesh(engine, emptyCap, accent);
  sectionCap.root.visible = false;

  const cube = ViewCube.attach(engine, { size: 47, theme: 'dark', home: true, duration: .27 });
  let section = sectionLimit;
  let selected = 0;

  function redrawDimension() {
    const offset = section / 1000;
    const full = section === sectionLimit;
    const width = full ? 2 * dimensions.boreRadius : boreChord(offset);
    const show = selected > 0 && width > 0;
    dimension.visible = measure.visible = show;
    if (!show) return;

    const x = dimensions.centers[selected - 1], left = x - width / 2, right = x + width / 2;
    const y = (full ? .28 : .141);
    const z = full ? 0 : offset + .003;
    dimension.setPositions([left,y,z,right,y,z, left,y-.007,z,left,y+.007,z, right,y-.007,z,right,y+.007,z]);
    const symbol = full ? 'Ø' : '';
    tag.textContent = symbol + (width * 1000).toFixed(1) + ' mm';
    measure.setPosition([x, y + .021, z]);
  }

  function setSection(depth) {
    section = depth;
    const full = section === sectionLimit;
    const plane = section / 1000;
    const cut = full ? null : makeSection(mesh, plane);
    const planes = full ? [] : [[0,0,-1,plane]];
    for (const material of materials) material.clippingPlanes = planes;
    feature.material.clippingPlanes = planes;
    const hasCap = !!cut?.geometry.indices.length;
    sectionCap.root.visible = outline.visible = hasCap;
    if (hasCap) {
      sectionCap.setGeometry(cut.geometry);
      outline.setPositions(cut.outline);
    }
    redrawDimension();
    return cut?.area ?? 0;
  }

  function setBore(bore) {
    selected = bore;
    selection.set(bore ? [body[bore + 3].root] : []);
    redrawDimension();
  }
  return { cube, setSection, setBore };
}