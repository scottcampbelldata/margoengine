// Transport oracle only. Does not execute WGSL. Hardware parity is a separate mandatory proof.
import assert from 'node:assert/strict';
import { hash5, pcg } from '../src/hash.ts';
import { standAt } from '../src/stands.ts';
import { divFloor, qmul } from '../src/fixed.ts';
export function installGPUConstants(t) {
  for (const [name, value] of Object.entries({
    GPUBufferUsage: { STORAGE: 128, COPY_DST: 8, COPY_SRC: 4, MAP_READ: 1 },
    GPUMapMode: { READ: 1 },
  })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => (old ? Object.defineProperty(globalThis, name, old) : delete globalThis[name]));
  }
}
function poisson(mu, e0, h) {
  const u = h >>> 16;
  let p = e0,
    cdf = p,
    k = 0;
  while (u >= cdf && k < 40) {
    k++;
    p = divFloor(p * mu, k * 65536);
    if (!p) break;
    cdf += p;
  }
  return k;
}
function cluster(data, at, x, z) {
  const reach = data[at + 9],
    cell = data[at + 10];
  if (!reach) return 65536;
  let sum = 0;
  for (let pz = divFloor(z - reach, cell); pz <= divFloor(z + reach, cell); pz++)
    for (let px = divFloor(x - reach, cell); px <= divFloor(x + reach, cell); px++) {
      const n = poisson(data[at + 11], data[at + 12], hash5(data[at], data[at + 14], px, pz, 0));
      for (let i = 1; i <= n; i++) {
        const h = hash5(data[at], data[at + 14], px, pz, i),
          ox = px * cell + Math.floor(((h >>> 16) * cell) / 65536),
          oz = pz * cell + Math.floor(((h & 65535) * cell) / 65536),
          d2 = (x - ox) ** 2 + (z - oz) ** 2;
        if (d2 >= reach * reach) continue;
        const t = divFloor(d2 * 16384, reach * reach),
          j = t >> 6,
          f = t & 63,
          table = data[at + 15];
        sum += data[table + j] + (((data[table + j + 1] - data[table + j]) * f) >> 6);
      }
    }
  const beta = data[at + 13];
  return 65536 - beta + qmul(beta, Math.min(4 * 65536, sum));
}
const DX = [1, 1, 0, -1, -1, -1, 0, 1],
  DZ = [0, 1, 1, 1, 0, -1, -1, -1];
function execute(name, buffers, { skip } = {}) {
  const [input, second, third, fourth] = buffers.map((b) => new Int32Array(b.bytes));
  const n = input[0];
  if (name === 'counts' || name === 'emit') {
    const out = second;
    for (let k = 0; k < n; k++) {
      const a = 1 + 18 * k;
      if (name === 'counts')
        out[k] = poisson(input[a + 5], input[a + 6], hash5(input[a], input[a + 1], input[a + 2], input[a + 3], 0));
      else {
        const h0 = hash5(input[a], input[a + 1], input[a + 2], input[a + 3], input[a + 16]),
          h1 = pcg(h0),
          h2 = pcg(h1),
          h3 = pcg(h2),
          h4 = pcg(h3),
          x = input[a + 2] * input[a + 4] + Math.floor(((h0 >>> 8) * input[a + 4]) / 16777216),
          z = input[a + 3] * input[a + 4] + Math.floor(((h1 >>> 8) * input[a + 4]) / 16777216);
        out.set(
          [
            h0,
            h1,
            h2,
            h3,
            h4,
            x,
            z,
            input[a + 7] ? standAt(input[a], { scale: input[a + 7], top: input[a + 8] }, x, z) : 65536,
            cluster(input, a, x, z),
          ],
          9 * k,
        );
      }
      if (skip !== name) out[(name === 'counts' ? n : 9 * n) + k] = 1;
    }
  } else if (name === 'accept' || name === 'kill') {
    for (let i = 0; i < n; i++) {
      const round = Math.floor(fourth[i] / 2) + 1;
      let value = second[i];
      if (!value) {
        const neighbours = input.subarray(input[1 + i], input[2 + i]);
        if (name === 'accept' && !neighbours.some((j) => second[j] === 0)) value = round * 4 + 1;
        if (name === 'kill' && neighbours.some((j) => second[j] === round * 4 + 1)) value = round * 4 + 2;
      }
      third[i] = value;
      if (skip !== name) fourth[i]++;
    }
  } else {
    const nx = input[1],
      nz = input[2];
    for (let c = 0; c < n; c++) {
      const x = c % nx,
        z = Math.floor(c / nx);
      let pick = -1,
        best = 0,
        sum = 1;
      for (let d = 0; d < 8; d++) {
        const u = x + DX[d],
          v = z + DZ[d];
        if (u < 0 || v < 0 || u >= nx || v >= nz) continue;
        const k = v * nx + u;
        if (name === 'd8') {
          const drop = input[3 + c] - input[3 + k],
            score = drop > 0 ? drop * drop * (d & 1 ? 1 : 2) : 0;
          if (!second[c] && score > best) {
            best = score;
            pick = d;
          }
        } else if (input[3 + k] === ((d + 4) & 7)) sum += second[k];
      }
      if (name === 'd8') {
        third[c] = pick;
        third[n + c] = pick < 0 && !second[c] && x > 0 && z > 0 && x < nx - 1 && z < nz - 1 ? 1 : 0;
      } else {
        third[c] = sum;
        if (sum !== second[c]) fourth[n]++;
      }
      if (skip !== name) fourth[c]++;
    }
  }
}
export function fakeDevice(options = {}) {
  const buffers = [],
    listeners = new Map(),
    dispatch = [];
  let scopes = 0,
    maps = 0,
    allocations = 0,
    lose;
  const lost = new Promise((resolve) => (lose = resolve));
  const device = {
    limits: {
      maxBufferSize: 2 ** 30,
      maxStorageBufferBindingSize: 2 ** 30,
      maxComputeWorkgroupsPerDimension: 65535,
      maxComputeInvocationsPerWorkgroup: 256,
      maxComputeWorkgroupSizeX: 256,
    },
    lost,
    addEventListener: (n, f) => listeners.set(n, f),
    removeEventListener: (n) => listeners.delete(n),
    pushErrorScope() {
      scopes++;
    },
    popErrorScope: async () => {
      scopes--;
      return options.fail === 'scope' ? { message: 'scope failure' } : null;
    },
    createShaderModule: () => ({
      getCompilationInfo: async () => ({ messages: options.fail === 'compile' ? [{ message: 'bad shader' }] : [] }),
    }),
    createComputePipelineAsync: ({ compute: { entryPoint } }) => {
      options.onPipeline?.();
      if (options.fail === 'sync-pipeline') {
        if (entryPoint === 'emit' || entryPoint === 'accumulate') throw Error('synchronous pipeline failure');
        return Promise.reject(Error('secondary pipeline rejection'));
      }
      if (options.fail === 'pipeline') return Promise.reject(Error('pipeline failure'));
      return Promise.resolve({ name: entryPoint, getBindGroupLayout: () => ({}) });
    },
    createBuffer: ({ size }) => {
      if (options.fail === 'allocation' && ++allocations === 2) throw RangeError('allocation failure');
      const buffer = {
        bytes: new ArrayBuffer(size),
        destroyed: false,
        mapAsync: async () => {
          maps++;
          if (options.fail === 'map') throw Error('mapping failure');
          if (options.fail === 'uncaptured')
            listeners.get('uncapturederror')?.({ error: { message: 'uncaptured failure' } });
          if (options.fail === 'lost') {
            lose({ message: 'test device loss' });
            await new Promise(() => {});
          }
          await options.onMap?.(maps);
        },
        getMappedRange() {
          return this.bytes;
        },
        unmap() {},
        destroy() {
          this.destroyed = true;
        },
      };
      buffers.push(buffer);
      return buffer;
    },
    createBindGroup: ({ entries }) => entries.map((e) => e.resource.buffer),
    createCommandEncoder: () => {
      const commands = [];
      return {
        beginComputePass() {
          let pipeline, group;
          return {
            setPipeline: (p) => (pipeline = p),
            setBindGroup: (_, g) => (group = g),
            dispatchWorkgroups: (x, y, z) => {
              if (options.fail === 'dispatch') throw Error('dispatch failure');
              const n = new Int32Array(group[0].bytes)[0],
                wantX = Math.min(Math.ceil(n / 64), device.limits.maxComputeWorkgroupsPerDimension);
              assert.deepEqual([x, y, z], [wantX, Math.ceil(n / (64 * wantX)), undefined]);
              dispatch.push([pipeline.name, x, y]);
              commands.push(() => execute(pipeline.name, group, options));
            },
            end() {},
          };
        },
        clearBuffer: (b, offset = 0, size = b.bytes.byteLength - offset) =>
          commands.push(() => new Uint8Array(b.bytes, offset, size).fill(0)),
        copyBufferToBuffer: (a, ao, b, bo, size) =>
          commands.push(() => new Uint8Array(b.bytes, bo, size).set(new Uint8Array(a.bytes, ao, size))),
        finish: () => commands,
      };
    },
    queue: {
      writeBuffer: (b, offset, source) =>
        new Uint8Array(b.bytes, offset, source.byteLength).set(
          new Uint8Array(source.buffer, source.byteOffset, source.byteLength),
        ),
      submit: (commands) => commands.flat().forEach((f) => f()),
    },
  };
  return {
    device,
    buffers,
    dispatch,
    listeners,
    get scopes() {
      return scopes;
    },
    lose,
    assertFreed() {
      assert.ok(
        buffers.every((b) => b.destroyed),
        'all GPU buffers destroyed',
      );
      assert.equal(listeners.size, 0);
      assert.equal(scopes, 0);
    },
  };
}
