import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const { page, close } = await openBrowser({ startPath: '/tools/shot/blank.html', port: 'free' });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
try {
  const result = await page.evaluate(async () => {
    const [
      { EngineKernel, Geometry, PbrMaterial, box },
      { PostStack },
      { ParticleLiquid },
      { TerrainBed },
      { ViscoplasticSolver, VISCOPLASTIC_INLET_WORDS, VISCOPLASTIC_LAYOUT },
      { PhysicsWorld, regionWords },
    ] = await Promise.all([
      import('/packages/core/dist/index.js'),
      import('/packages/post/dist/stack.js'),
      import('/packages/water/dist/liquid.js'),
      import('/packages/physics/dist/earth.js'),
      import('/packages/physics/dist/viscoplastic.js'),
      import('/packages/physics/dist/world.js'),
    ]);

    const width = 320;
    const height = 200;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = `display:block;width:${width}px;height:${height}px`;
    document.body.style.margin = '0';
    document.body.replaceChildren(canvas);
    using engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      exactSize: [width, height],
      camera: { position: [1, 1.05, 2.12], target: [1, 0.07, 0.5], fov: 45, near: 0.12, far: 8 },
    });
    engine.stop();
    engine.scene.background = '#716a61';
    engine.lighting.direction.set([-0.5, 1, 0.45, 2]);
    engine.lighting.radiance.set([1, 0.95, 0.9, 0.28]);

    // A fixed-camera flume at lab scale, with the same sloping bed in the solver and scene.
    const bed = (x) => 0.16 - 0.07 * x;
    const floor = new Geometry(
      [0, bed(0), 0, 0, bed(0), 1, 2, bed(2), 0, 2, bed(2), 1],
      [0.07, 1, 0, 0.07, 1, 0, 0.07, 1, 0, 0.07, 1, 0],
      [0, 1, 2, 2, 1, 3],
    );
    engine
      .createMesh()
      .setGeometry(floor)
      .setMaterial(new PbrMaterial({ color: '#a69b87', roughness: 0.88 }));
    const frame = new PbrMaterial({ color: '#565b5e', metalness: 0.45, roughness: 0.43 });
    const rail = box(2.08, 0.2, 0.035);
    for (const z of [-0.018, 1.018]) {
      engine.createMesh().setGeometry(rail).setMaterial(frame).setPosition([1, 0.12, z]);
    }
    const cap = box(0.035, 0.21, 1.035);
    for (const x of [-0.018, 2.018]) {
      engine.createMesh().setGeometry(cap).setMaterial(frame).setPosition([x, 0.12, 0.5]);
    }
    engine
      .createMesh()
      .setGeometry(box(2.6, 0.055, 1.5))
      .setMaterial(new PbrMaterial({ color: '#5c554d', roughness: 0.95 }))
      .setPosition([1, -0.035, 0.5]);

    const inletStart = 6;
    const inletEnd = 30;
    const jets = 6;
    const jetRate = 0.004;
    const fps = 60;
    const capacity = jets * (inletEnd - inletStart) + 8;
    const referenceVolume = (jets * jetRate * (inletEnd - inletStart)) / fps;
    const viewportCell = [361_000, 0, -190_200];
    const labCell = [viewportCell[0] - 1, 0, viewportCell[2]];
    const cellWidth = 4096;
    let renderCell = viewportCell;
    const inlet = {
      name: 'visual-flume-inlet',
      kind: 'particleSet',
      quantity: 'volumeRate',
      unit: 'SI',
      centring: 'particle',
    };

    class TimedInlet {
      describe() {
        return { id: 'visual-flume-valve', rate: 0, stableRate: () => 0, fields: [{ field: inlet, access: 'write' }] };
      }

      init(host) {
        this.host = host;
        this.region = host.allocate('inflow-rows', 8 * jets * VISCOPLASTIC_INLET_WORDS, 'f64', VISCOPLASTIC_LAYOUT);
      }

      importPorts() {}

      step({ tick }) {
        const rate = tick >= inletStart && tick < inletEnd ? jetRate : 0;
        const rows = regionWords(this.host.memory, this.region);
        for (let jet = 0; jet < jets; jet++) {
          rows.set(
            [cellWidth + 0.23, bed(0.23) + 0.07, 0.35 + 0.06 * jet, 0.8, -0.04, 0, rate],
            jet * VISCOPLASTIC_INLET_WORDS,
          );
        }
      }

      exportPorts(tick) {
        return [{ field: inlet.name, region: this.region, tick, cell: this.host.cell }];
      }

      stateRegions() {
        return [this.region];
      }

      extraState() {
        return [];
      }
    }

    const terrain = { columns: 16, rows: 8, width: 2, depth: 1, centre: [cellWidth + 1, 0.5] };
    const mud = await ViscoplasticSolver.load({ terrain, inlet });
    const world = new PhysicsWorld({ rate: { num: fps, den: 1 } })
      .add(new TerrainBed(), { ...terrain, elevations: (x) => bed(x - cellWidth) }, labCell)
      .add(new TimedInlet(), {}, labCell)
      .add(
        mud,
        {
          cells: [16, 8, 8],
          spacing: 0.125,
          origin: [cellWidth, 0, 0],
          capacity,
          density: 1600,
          bulkModulus: 8000,
          shearModulus: 320,
          yieldStress: 20,
          consistency: 10,
          exponent: 0.65,
          solventViscosity: 3,
          friction: 0.02,
        },
        labCell,
      );

    const gpu = engine.gpu;
    const errors = [];
    engine.onError = (error) => errors.push(String(error));
    gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    gpu.pushErrorScope('validation');
    const bytes = width * height * 16;
    const image = gpu.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const staging = gpu.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const readPipeline = gpu.createComputePipeline({
      layout: 'auto',
      compute: {
        module: gpu.createShaderModule({
          code: `
          @group(0) @binding(0) var source: texture_2d<f32>;
          @group(0) @binding(1) var<storage, read_write> result: array<vec4f>;
          @compute @workgroup_size(8, 8)
          fn main(@builtin(global_invocation_id) id: vec3u) {
            let size = textureDimensions(source);
            if (any(id.xy >= size)) { return; }
            result[id.x + id.y * size.x] = textureLoad(source, vec2i(id.xy), 0);
          }
        `,
        }),
        entryPoint: 'main',
      },
    });
    const readout = {
      name: 'flume-test-readout',
      setup() {},
      joinStack: () => ({
        kind: 'hdr',
        render(context, source) {
          const pass = context.encoder.beginComputePass();
          pass.setPipeline(readPipeline);
          pass.setBindGroup(
            0,
            gpu.createBindGroup({
              layout: readPipeline.getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: source },
                { binding: 1, resource: { buffer: image } },
              ],
            }),
          );
          pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
          pass.end();
          return source;
        },
      }),
    };
    const stack = PostStack.attach(engine, [readout]);
    async function shot() {
      engine.render({ delta: 0 });
      const encoder = gpu.createCommandEncoder();
      encoder.copyBufferToBuffer(image, 0, staging, 0, bytes);
      gpu.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const pixels = new Float32Array(staging.getMappedRange()).slice();
      staging.unmap();
      if (!pixels.every(Number.isFinite)) throw new Error('Flume renderer returned a nonfinite HDR component.');
      return pixels;
    }

    const packed = new Float32Array(capacity * 6);
    const source = () => mud.particleSource(packed, renderCell);
    function accepted() {
      const p = source();
      if (
        p.count !== mud.budget.activePoints ||
        p.stride !== 6 ||
        p.velocityOffset !== 3 ||
        p.positions.buffer !== packed.buffer ||
        p.velocities !== p.positions
      ) {
        throw new Error('The renderer source does not borrow the accepted interleaved point rows.');
      }
      let index = 0;
      let front = 0;
      for (let i = 0; i < capacity; i++) {
        const point = mud.sample(i);
        if (!point.present) continue;
        const [x, y, z] = point.position;
        const renderX = x - cellWidth;
        front = Math.max(front, renderX);
        const expected = [renderX, y, z, ...point.velocity];
        for (let j = 0; j < expected.length; j++) {
          if (p.positions[index * 6 + j] !== Math.fround(expected[j])) {
            throw new Error('The renderer source changed an accepted point position or velocity.');
          }
        }
        index++;
      }
      if (index !== p.count) throw new Error('The renderer source includes an inactive slot.');
      return {
        p,
        count: p.count,
        front,
        hash: world.hash(),
        injected: mud.budget.injectedReferenceVolume,
        stored: mud.budget.storedReferenceVolume,
      };
    }
    function describe(image, bare) {
      let count = 0;
      let xTotal = 0;
      for (let i = 0; i < image.length; i += 4) {
        if (image[i] === bare[i] && image[i + 1] === bare[i + 1] && image[i + 2] === bare[i + 2]) continue;
        xTotal += (i / 4) % width;
        count++;
      }
      return { count, centre: count ? xTotal / count : 0 };
    }
    const same = (a, b) => a.every((sample, i) => sample === b[i]);
    let liquid;
    try {
      const bare = await shot();
      world.advance(4);
      const dry = accepted();
      // Volume-equivalent particle spheres in metres. The material's colour is chosen for the flume.
      const radius = Math.cbrt((3 * jetRate) / (4 * Math.PI * fps));
      liquid = ParticleLiquid.attach(engine, {
        particles: dry.p,
        radius,
        ior: 1.39,
        color: [1.05, 0.72, 0.36],
        absorption: [1, 5, 12],
        thicknessScale: 1,
      });
      stack.moveEffect(readout, 1);
      const empty = await shot();

      async function frame(frameNumber) {
        world.advance(frameNumber);
        const { p, ...state } = accepted();
        liquid.update(p);
        const pixels = await shot();
        if (liquid.particleCount !== state.count || liquid.frameStats.particles !== state.count)
          throw new Error('The liquid pass did not draw the accepted active point count.');
        return { state, pixels, mask: describe(pixels, bare) };
      }

      const early = await frame(16);
      const checkpoint = world.takeSnapshot();
      world.shiftOrigin(viewportCell);
      renderCell = [0, 0, 0];
      const moving = await frame(34);
      const stopped = await frame(72);

      world.restoreSnapshot(checkpoint.bytes);
      renderCell = viewportCell;
      const rewind = await frame(16);
      world.shiftOrigin(viewportCell);
      renderCell = [0, 0, 0];
      const replay = await frame(72);
      liquid.dispose();
      liquid = undefined;
      const detached = await shot();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      return {
        early: early.state,
        moving: moving.state,
        stopped: stopped.state,
        rewind: rewind.state,
        replay: replay.state,
        earlyPixels: early.mask,
        movingPixels: moving.mask,
        stoppedPixels: stopped.mask,
        dryCount: dry.count,
        referenceVolume,
        dryUnchanged: same(bare, empty),
        detachedUnchanged: same(bare, detached),
        rewindExact: same(early.pixels, rewind.pixels),
        replayExact: same(stopped.pixels, replay.pixels),
        compat: globalThis.__margoCompat === true,
        validation,
        errors,
      };
    } finally {
      liquid?.dispose();
      stack.dispose();
      staging.destroy();
      image.destroy();
    }
  });

  const receipt = JSON.stringify(result);
  assert.equal(result.validation, null, receipt);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(pageErrors, []);
  assert.equal(result.compat, process.argv.includes('--compat') || process.env.MARGO_COMPAT === '1');
  assert.equal(result.dryCount, 0);
  assert.equal(result.dryUnchanged, true);
  assert.equal(result.early.count, 60);
  assert.equal(result.moving.count, 144);
  assert.equal(result.stopped.count, result.moving.count);
  assert.ok(result.moving.front > result.early.front && result.stopped.front > result.moving.front, receipt);
  assert.ok(result.earlyPixels.count > 0 && result.movingPixels.count > 0 && result.stoppedPixels.count > 0, receipt);
  assert.ok(
    result.movingPixels.centre > result.earlyPixels.centre && result.stoppedPixels.centre > result.movingPixels.centre,
    receipt,
  );
  assert.ok(Math.abs(result.moving.injected - result.referenceVolume) <= 128 * Number.EPSILON * result.referenceVolume);
  assert.ok(Math.abs(result.stopped.stored - result.referenceVolume) <= 256 * Number.EPSILON * result.referenceVolume);
  assert.equal(result.stopped.injected, result.moving.injected);
  assert.deepEqual(result.rewind, result.early);
  assert.deepEqual(result.replay, result.stopped);
  assert.equal(result.rewindExact, true);
  assert.equal(result.replayExact, true);
  assert.equal(result.detachedUnchanged, true);
  console.log(
    `FLUID-06 ${result.compat ? 'WebGL2' : 'WebGPU'} flume ${result.stopped.hash}: ${result.earlyPixels.count}/${result.movingPixels.count}/${result.stoppedPixels.count} liquid pixels, front ${result.stopped.front.toFixed(4)} m, exact rewind and replay.`,
  );
} finally {
  await close();
}
