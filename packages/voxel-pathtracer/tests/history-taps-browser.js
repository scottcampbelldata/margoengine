// Exercise the production combine kernel with independently controlled surface masks.
// A two-by-two history projects to four equal bilinear weights. Rejected taps must
// contribute neither color nor weight, including a rejected HDR foreground.
export async function historyTapCheck(device, source) {
  if (typeof source !== 'string') throw new Error('Missing compiled production denoiser source');
  const owned = [],
    U = GPUBufferUsage,
    C = GPUShaderStage.COMPUTE,
    buffer = (data, usage) => {
      const value = device.createBuffer({ size: data.byteLength, usage, mappedAtCreation: true });
      new Uint8Array(value.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      value.unmap();
      owned.push(value);
      return value;
    },
    // Every input here is an exactly representable positive half, including 32768.
    half = (v) => {
      if (v === 0) return 0;
      const e = Math.floor(Math.log2(v));
      return ((e + 15) << 10) | ((v / 2 ** e - 1) * 1024);
    },
    pair = (a, b) => (half(a) | (half(b) << 16)) >>> 0;
  try {
    const layout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: C, buffer: { type: 'uniform' } },
          ...[1, 2, 3, 4, 5, 6, 7, 8].map((binding) => ({
            binding,
            visibility: C,
            buffer: { type: [5, 6, 8].includes(binding) ? 'storage' : 'read-only-storage' },
          })),
          { binding: 9, visibility: C, texture: { sampleType: 'uint' } },
          { binding: 10, visibility: C, storageTexture: { access: 'write-only', format: 'rgba32uint' } },
        ],
      }),
      module = device.createShaderModule({ code: source }),
      pipeline = await device.createComputePipelineAsync({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module, entryPoint: 'combine' },
      }),
      params = new Uint32Array(128),
      floats = new Float32Array(params.buffer);
    params.set([2, 2, 1, 8 | 16]);
    params.set([0, 0, 2, 2], 8);
    // Finite forward rays hit (0, 0, 1). Identity reprojection places that point
    // at the history image's centre: the four old pixels each have weight 1/4.
    // A zero ray is invalid (normalize(0)) and would never exercise history.
    for (let i = 0; i < 4; i++) {
      floats[28 + 4 * i + 2] = 1;
      floats[76 + 4 * i + 2] = 1;
    }
    floats.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 44);
    const uniform = buffer(params, U.UNIFORM | U.COPY_DST),
      data = Array.from({ length: 8 }, () => new Float32Array(16));
    for (let i = 0; i < 4; i++) {
      data[0].set([1, 1, 1, 1], i * 4);
      data[1].set([1, 1, 1, 1], i * 4);
      data[2].set([0, 0, 1, 1], i * 4);
      data[4].set([1, 1, 1, 1], i * 4);
      data[5].set([0, 0, 1, 1], i * 4);
    }
    const images = data.map((a) => buffer(a, U.STORAGE | U.COPY_DST | U.COPY_SRC)),
      texture = () => {
        const value = device.createTexture({
          size: [2, 2],
          format: 'rgba32uint',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST,
        });
        owned.push(value);
        return value;
      },
      hin = texture(),
      hout = texture(),
      staging = buffer(new Uint32Array(16), U.COPY_DST | U.MAP_READ),
      group = device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          ...images.map((value, i) => ({ binding: i + 1, resource: { buffer: value } })),
          { binding: 9, resource: hin.createView() },
          { binding: 10, resource: hout.createView() },
        ],
      }),
      rows = [],
      cases = [
        ...[1, 8, 65536].flatMap((samples) =>
          [
            [2, 4, 8, 16],
            [32768, 0, 16, 2],
          ].map((colors) => ({ samples, colors, weight: 8 })),
        ),
        { samples: 1, colors: [2, 4, 8, 16], weight: 0 },
      ];
    for (const { samples, colors, weight } of cases) {
      floats[7] = 1 / samples;
      device.queue.writeBuffer(uniform, 0, params);
      for (let mask = 0; mask < 16; mask++) {
        const history = new Uint32Array(16);
        for (let i = 0; i < 4; i++)
          history.set([0, 0, pair(colors[i], colors[i]), pair(colors[i], weight + 16 * mask)], i * 4);
        device.queue.writeTexture({ texture: hin }, history, { bytesPerRow: 32 }, { width: 2, height: 2 });
        const encoder = device.createCommandEncoder(),
          pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(1);
        pass.end();
        encoder.copyBufferToBuffer(images[7], 0, staging, 0, 64);
        device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const actual = new Float32Array(staging.getMappedRange()).slice(0, 4);
        staging.unmap();
        const valid = colors.filter((_, i) => (mask & (1 << i)) !== 0),
          effective = weight * Math.max(0, 1 - samples / 8),
          retained = valid.length ? effective : 0,
          historyMean = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0,
          expected = (samples + retained * historyMean) / (samples + retained);
        rows.push({ mask, samples, colors, weight, actual: [...actual], expected, expectedWeight: samples + retained });
      }
    }
    await device.queue.onSubmittedWorkDone();
    return rows;
  } finally {
    for (const value of owned) value.destroy();
  }
}
