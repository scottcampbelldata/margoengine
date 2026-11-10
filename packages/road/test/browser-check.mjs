import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { trackPipelines } from '../../../scripts/support/gpu-ready.js';
import { decodePNG } from '../../../tests/support/png.js';

const cacheDir = await mkdtemp(join(tmpdir(), 'margo-road-'));
const server = await createServer({
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  cacheDir,
  configFile: false,
  logLevel: 'error',
  optimizeDeps: { entries: [], noDiscovery: true, include: [] },
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  plugins: [
    {
      name: 'road-check',
      configureServer(s) {
        s.middlewares.use('/road-check', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end(
            '<!doctype html><title>Road backend proof</title><style>body{margin:0}canvas{width:128px;height:128px}</style><canvas></canvas>',
          );
        });
      },
    },
  ],
});
let browser;
const failures = [];
try {
  await server.listen();
  browser = await launchBrowser();
  for (const feature of ['junctions', 'intersections', 'lanes', 'banking', 'terrain', 'repair', 'markings', 'graph']) {
  for (const mode of ['native', 'compat']) {
    const page = await browser.newPage({ viewport: { width: 128, height: 128 } });
    page.setDefaultTimeout(120000);
    page.on('pageerror', (e) => failures.push(e.message));
    await page.addInitScript(trackPipelines);
    await page.goto(server.resolvedUrls.local[0] + 'road-check');
    const result = await page.evaluate(async ({mode, feature}) => {
      const { Engine, PbrMaterial } = await import('/packages/core/dist/index.js');
      const { junctions } = await import('/packages/road/dist/junctions.js');
      const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
      if (mode === 'compat') {
        const { install } = await import('/packages/webgl2-compat/dist/index.js');
        const installed = await install({ force: true });
        if (!installed.installed) throw new Error(installed.reason);
      }
      const engine = await Engine.create(document.querySelector('canvas'), {
        backend: 'webgpu',
        exactSize: [128, 128],
        camera: { fov: 45, position: [0, 30, 0.001], target: [0, 0, 0], near: 0.1, far: 100 },
      });
      engine.onError = (e) => {
        throw e;
      };
      const checkNetwork = async () => {
        if (feature !== 'graph') return;
        const {createCompute} = await import('/packages/compute/dist/index.js');
        const {shortestPaths, bfs} = await import('/packages/compute/dist/graph.js');
        const {roadGraph} = await import('/packages/road/dist/graph.js');
        const {Spline} = await import('/packages/splines/dist/index.js');
        using gpu = await createCompute({engine});
        if(gpu.backend !== 'webgpu') throw new Error('Expected device-backed graph');
        const roads = [
          {from:0,to:1,curve:new Spline([[0,0,0],[100,0,0]]),speed:10,direction:'forward'},
          {from:0,to:2,curve:new Spline([[0,0,0],[60,0,0]]),speed:10},
          {from:2,to:1,curve:new Spline([[0,0,0],[60,0,0]]),speed:10},
        ];
        const verify = async (g,start,expected,parents) => {
          const r=await shortestPaths(g,start,{checkEvery:1});
          try {
            const d=Array.from(await r.distances.read()), p=Array.from(await r.predecessors.read());
            if(r.negativeCycle || d.some((v,i)=>v!==expected[i]) || p.some((v,i)=>v!==parents[i])) throw new Error(`Road routing oracle ${d}; ${p}`);
          } finally {r.distances.dispose();r.predecessors.dispose();}
        };
        using free=roadGraph(gpu,{vertices:4,roads});
        await verify(free,0,[0,10,6,Infinity],[-1,0,0,-1]);
        await verify(free,1,[12,0,6,Infinity],[2,-1,1,-1]);
        using busy=roadGraph(gpu,{vertices:4,roads:[{...roads[0],traffic:2,delay:3},...roads.slice(1)]});
        await verify(busy,0,[0,12,6,Infinity],[-1,2,0,-1]);
        using reverse=roadGraph(gpu,{vertices:2,roads:[{...roads[0],direction:'reverse'}]});
        await verify(reverse,0,[0,Infinity],[-1,-1]);
        await verify(reverse,1,[10,0],[1,-1]);
        for(const length of [2**-126,2**126]) {
          using extreme=roadGraph(gpu,{vertices:2,roads:[{from:0,to:1,curve:{length},speed:1}]});
          await verify(extreme,0,[0,length],[-1,0]);
        }
        const r=await bfs(free,0,{checkEvery:1});
        try {if(String(await r.distances.read())!=='0,1,1,-1')throw new Error('Road reachability oracle');}
        finally {r.distances.dispose();r.predecessors.dispose();}
        const signal=AbortSignal.abort(new Error('cancel route'));
        let cancelled=false;
        try {await shortestPaths(free,0,{signal});}catch(e){cancelled=e===signal.reason;}
        if(!cancelled)throw new Error('Routing must honor abort');
        free.dispose();free.dispose();busy.dispose();busy.dispose();
        using isolated=roadGraph(gpu,{vertices:2});await verify(isolated,0,[0,Infinity],[-1,-1]);
        gpu.dispose();gpu.dispose();
      };
      await checkNetwork();
      let data;
      if (feature === 'intersections') {
        const {intersections}=await import('/packages/road/dist/intersections.js');
        data=await intersections([{points:[[-10,0],[10,0]],width:4},{points:[[0,-10],[0,10]],width:4}],{elevation:(x,z)=>0.02*x+0.03*z});
        if(!(data.area>144 && data.curb.area>0 && data.sidewalk.area>0))throw new Error('Intersection design oracle');
      } else if (feature === 'lanes') {
        const {road}=await import('/packages/road/dist/index.js');
        const {Spline}=await import('/packages/splines/dist/index.js');
        const {lanes}=await import('/packages/road/dist/lanes.js');
        const curve=new Spline([[0,0,-10],[2,0,0],[0,0,10]]);
        data=road(curve,{crossSection:[[-4,0],[4,0]]});
        data.paint=lanes(curve,{widths:[3,3],lines:[{width:0.35},{width:0.35,dash:[2,2]},{width:0.35}],arrows:[{lane:1,distance:curve.length/2,length:4,width:1.5}]});
      } else if (feature === 'markings') {
        const {road} = await import('/packages/road/dist/index.js');
        const {Spline} = await import('/packages/splines/dist/index.js');
        data=road(new Spline([[0,0,-10],[0,0,10]]),{crossSection:[[-3,0],[3,0]]});
      } else if (feature === 'repair') {
        const {repairRoad} = await import('/packages/road/dist/repair.js');
        const {Spline} = await import('/packages/splines/dist/index.js');
        data=await repairRoad(new Spline([[-2,0,-8],[-2,0,8],[0,0,9],[2,0,8],[2,0,-8]]),{width:8});
        if (!(data.area>100)) throw new Error('Repair area oracle');
      } else if (feature === 'terrain') {
        const {road} = await import('/packages/road/dist/index.js');
        const {fitTerrain} = await import('/packages/road/dist/terrain.js');
        const {Spline} = await import('/packages/splines/dist/index.js');
        const {heightfieldGeometry} = await import('/packages/terrain/dist/index.js');
        const {Geometry} = await import('/packages/core/dist/index.js');
        const surface=road(new Spline([[0,2,-10],[0,2,10]]),{crossSection:[[-3,0],[3,0]]});
        const cut=await fitTerrain(surface.geometry,{base:()=>5});
        const fill=await fitTerrain(surface.geometry,{base:()=>-5});
        if(cut(0,0)!==2 || fill(0,0)!==2 || cut(10,0)!==5 || fill(10,0)!==-5) throw new Error('Cut/fill value oracle');
        const oblique=road(new Spline([[0,2,0],[17,2,23]]),{segments:1,crossSection:[[-3,0],[3,0]]});
        const zero=await fitTerrain(oblique.geometry,{base:()=>-10,shoulder:0});
        if(Math.abs(zero(13.5,23)-2)>1e-6)throw new Error('Oblique zero-shoulder footprint');
        const {bankedRoad}=await import('/packages/road/dist/banking.js');
        const curbed=await bankedRoad(new Spline([[0,0,0],[0,0,20]]),{bank:Math.PI/4,segments:4});
        const bed=await fitTerrain(curbed.geometry);
        for(const z of [1,5,9]) if(Math.abs(bed(2.1,z)-2.1)>1e-6)throw new Error('Banked curb lower envelope');
        const ground=heightfieldGeometry(fill,{size:[20,20],resolution:20});
        data={geometry:new Geometry(ground.positions,ground.normals,ground.indices)};
      } else if (feature === 'banking') {
        const {bankedRoad} = await import('/packages/road/dist/banking.js');
        const {Spline} = await import('/packages/splines/dist/index.js');
        data = await bankedRoad(new Spline([[0,0,-10],[0,0,10]]), {bank:Math.PI/6, crossSection:[[-3,0],[3,0]]});
        if (Math.abs(data.geometry.vertices[1]+1.5)>1e-6) throw new Error('Bank height oracle');
        const loop=await bankedRoad(new Spline([[0,0,0],[30,0,0],[30,0,30],[0,0,30]],{closed:true}),{bank:0.2});
        const vertices=loop.geometry.vertices,row=(loop.section.length-1)*2;
        for(let i=0;i<row*6;i++) if(vertices[i]!==vertices[128*row*6+i])throw new Error('Periodic banked positions and normals');
      } else data = await junctions([
        {
          points: [
            [-10, 0],
            [10, 0],
          ],
          width: 4,
        },
        {
          points: [
            [0, -10],
            [0, 10],
          ],
          width: 4,
        },
      ]);
      const mesh = engine
        .createMesh()
        .setGeometry(data.geometry)
        .setMaterial(new PbrMaterial({ color: '#ff0000' }));
      const extraMeshes=[];
      if(feature==='intersections')for(const [part,color] of [[data.curb,'#0000ff'],[data.sidewalk,'#00ff00']])extraMeshes.push(engine.createMesh().setGeometry(part.geometry).setMaterial(new PbrMaterial({color})));
      if(feature==='lanes')for(const part of data.paint)extraMeshes.push(engine.createMesh().setGeometry(part.geometry).setMaterial(new PbrMaterial({color:'#ffffff'})));
      let paint;
      if(feature === 'markings') {
        const {Tonemap}=await import('/packages/tonemap/dist/index.js');
        const {Decals}=await import('/packages/post/dist/decals.js');
        const {markings}=await import('/packages/road/dist/markings.js');
        Tonemap.attach(engine,{curve:'neutral'});
        paint=Decals.attach(engine,{minPixels:0});
        paint.setDecals(markings([{kind:'line',position:[-1.25,0,0],length:20,width:0.5},{kind:'arrow',position:[1.25,0,0],length:5,width:1.5}]));
        if(paint.count!==4)throw new Error('Marking projector count');
      }
      const draw = () =>
        waitForPipelines(async () => {
          engine.render({ delta: 0 });
          await engine.gpu.queue.onSubmittedWorkDone();
        });
      window.check = {
        engine,
        mesh,
        data,
        draw,
        async reboot() {
          await engine.rebootDevice();
          await checkNetwork();
          await draw();
        },
        async remove() {
          paint?.dispose(); paint?.dispose();
          mesh.dispose();
          mesh.dispose();
          for(const extra of extraMeshes){extra.dispose();extra.dispose();}
          await draw();
        },
        dispose() {
          engine.dispose();
          engine.dispose();
          return engine.disposed;
        },
      };
      await draw();
      return { area: data.area, backend: engine.backend, vendor: engine.gpu.adapterInfo?.vendor };
    }, {mode, feature});
    if (feature === 'junctions') assert.equal(result.area, 144);
    assert.equal(result.backend, 'webgpu');
    assert.equal(result.vendor === 'margo-webgl2', mode === 'compat');
    const pixels = () => page.locator('canvas').screenshot().then(decodePNG);
    const first = await pixels();
    const rgb = (p, x, y) => Array.from(p.data.subarray((y * p.width + x) * 4, (y * p.width + x) * 4 + 3));
    for (const [x, y] of (feature === 'lanes' ? [[64,24],[64,104]] : feature === 'markings' ? [[58,64],[58,24],[58,104]] : ['banking','repair'].includes(feature) ? [[64,64],[64,24],[64,104]] : [
      [64, 64],
      [24, 64],
      [104, 64],
      [64, 24],
      [64, 104],
    ])) {
      const [r, g, b] = rgb(first, x, y);
      if(feature === 'markings') assert.ok(Math.min(r,g,b)>60 && Math.max(r,g,b)-Math.min(r,g,b)<5, `${mode}: white paint at ${x},${y}: ${r},${g},${b}`);
      else assert.ok(r > g + 30 && r > b + 30, `${mode}: road covers ${x},${y}: ${r},${g},${b}`);
    }
    if(feature==='intersections') {
      let green=0,blue=0;for(let i=0;i<first.data.length;i+=4){const [r,g,b]=first.data.subarray(i,i+3);if(g>r+30&&g>b+30)green++;if(b>r+30&&b>g+30)blue++;}
      assert.ok(green>200&&blue>10, `${mode}: separate sidewalk and curb pixels ${green}/${blue}`);
    }
    if(feature==='lanes') {
      let white=0;for(let i=0;i<first.data.length;i+=4){const [r,g,b]=first.data.subarray(i,i+3);if(Math.min(r,g,b)>60&&Math.max(r,g,b)-Math.min(r,g,b)<5)white++;}
      assert.ok(white>200,`${mode}: curved lane lines and arrows paint ${white} pixels`);
    }
    if(feature === 'markings') {
      let white=0;for(let y=50;y<78;y++)for(let x=67;x<78;x++){const p=rgb(first,x,y);if(Math.min(...p)>60 && Math.max(...p)-Math.min(...p)<5)white++;}
      assert.ok(white>20,`${mode}: projected arrow paints its footprint: ${white}`);
    }
    const exterior = feature === 'terrain' ? [5,5] : [100,100];
    assert.ok(rgb(first, ...exterior)[0] < 40, `${mode}: corner outside road stays clear`);
    await page.evaluate(() => window.check.reboot());
    assert.deepEqual((await pixels()).data, first.data, `${mode}: retained geometry survives device reboot`);
    await page.evaluate(() => window.check.remove());
    const removed = await pixels();
    assert.ok(rgb(removed, 64, 64)[0] < 40, `${mode}: disposed mesh leaves no road`);
    assert.equal(await page.evaluate(() => window.check.dispose()), true);
    console.log(
      `PASS ${feature} ${mode}: road pixels, clear outside, exact reboot pixels, disposal`,
    );
    await page.close();
  }
  }
  assert.deepEqual(failures, []);
} finally {
  await closeAll({ browser, servers: [server] });
  await rm(cacheDir, { recursive: true, force: true });
}
