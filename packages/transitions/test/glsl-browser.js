export async function glslChecks() {
  const { Engine } = await import('../../core/dist/extension.js');
  const { translateGLSLTransition, createGLSLTransition, createLiveGLSLTransition } = await import('../dist/glsl.js');
  const { glslFixtures } = await import('./glsl-fixtures.js');
  const { fullscreen } = await import('../../shared/gpu.js');
  const assert = (ok, m) => {
    if (!ok) throw new Error(m);
  };
  const W = 16,
    H = 16;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const engine = await Engine.create(canvas, { exactSize: true });
  const d = engine.gpu;
  const errors = [];
  engine.onError = (e) => errors.push(e.message);
  d.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const native = document.createElement('canvas');
  native.width = W;
  native.height = H;
  const gl = native.getContext('webgl2', {
    preserveDrawingBuffer: true,
    antialias: false,
    alpha: true,
    premultipliedAlpha: false,
  });
  assert(gl, 'native WebGL2 oracle');
  const buffers = [],
    textures = [],
    shaders = [],
    programs = [];
  const input = (blue) => {
    const bytes = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        bytes[o] = blue ? 32 : Math.round(((x + 0.5) / W) * 255);
        bytes[o + 1] = Math.round(((y + 0.5) / H) * 255);
        bytes[o + 2] = blue ? Math.round(((x + 0.5) / W) * 255) : 16;
        bytes[o + 3] = 255;
      }
    return bytes;
  };
  const images = [];
  for (let i = 0; i < 2; i++) {
    const bytes = input(i === 1);
    const texture = d.createTexture({
      size: [W, H],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });
    textures.push(texture);
    images.push(texture);
    d.queue.writeTexture({ texture }, bytes, { bytesPerRow: W * 4 }, [W, H]);
    const reversed = new Uint8Array(bytes.length);
    for (let y = 0; y < H; y++) reversed.set(bytes.subarray(y * W * 4, (y + 1) * W * 4), (H - 1 - y) * W * 4);
    gl.activeTexture(gl.TEXTURE0 + i);
    const t = gl.createTexture();
    textures.push({ destroy: () => gl.deleteTexture(t) });
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, reversed);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  const target = d.createTexture({
    size: [W, H],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  textures.push(target);
  const settings = d.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM });
  buffers.push(settings);
  const vertex = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vertex);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    assert(gl.getShaderParameter(shader, gl.COMPILE_STATUS), 'native shader: ' + gl.getShaderInfoLog(shader));
    shaders.push(shader);
    return shader;
  };
  const vs = compile(
    gl.VERTEX_SHADER,
    '#version 300 es\nin vec2 position;out vec2 v_uv;void main(){gl_Position=vec4(position,0,1);v_uv=position*0.5+0.5;}',
  );
  const header =
    fullscreen +
    `@group(0) @binding(0) var<uniform> settings:vec4f;@group(0) @binding(1) var before:texture_2d<f32>;@group(0) @binding(2) var after:texture_2d<f32>;fn sample(t:texture_2d<f32>,uv:vec2f)->vec4f{let n=vec2i(textureDimensions(t));return textureLoad(t,clamp(vec2i(uv*vec2f(n)),vec2i(0),n-1),0);}`;
  let pixels = 0;
  // The oracle reads a texel by the product's own rule (src/builtin.ts sample(): truncate uv * size, clamp, with the
  // GLSL bottom-left flip), not through a NEAREST sampler, whose subtexel snap may round a lookup 6e-4 of a texel below
  // an edge up to the next texel on some GPUs (KB0191, Radeon 680M). The WebGPU spec's nearest rule picks the texel that
  // contains the coordinate; both sides now apply it in f32, so they agree exactly at the edge with no allowance.
  const oracleFetch =
    'vec4 margoFetch(sampler2D t,vec2 uv){ivec2 s=textureSize(t,0);ivec2 c=clamp(ivec2(vec2(uv.x,1.0-uv.y)*vec2(s)),ivec2(0),s-1);return texelFetch(t,ivec2(c.x,s.y-1-c.y),0);}' +
    'vec4 margoFetch(sampler2D t,vec2 uv,float bias){return margoFetch(t,uv);}' +
    'vec4 margoFetchProj(sampler2D t,vec3 p){return margoFetch(t,p.xy/p.z);}' +
    'vec4 margoFetchProj(sampler2D t,vec4 p){return margoFetch(t,p.xy/p.w);}' +
    'vec4 margoFetchProj(sampler2D t,vec3 p,float bias){return margoFetch(t,p.xy/p.z);}' +
    'vec4 margoFetchProj(sampler2D t,vec4 p,float bias){return margoFetch(t,p.xy/p.w);}\n';
  try {
    for (const fixture of glslFixtures) {
      const source = fixture.oracleSource ?? fixture.source;
      const declarations = 'uniform float progress;uniform float ratio;uniform sampler2D from;uniform sampler2D to;';
      const nativeSource = source.replace(
        /\buniform\s+(?:(?:lowp|mediump|highp)\s+)?\w+\s+(?:from|to|progress|ratio)\s*;/g,
        '',
      );
      const fs = compile(
        gl.FRAGMENT_SHADER,
        '#version 300 es\nprecision highp float;precision highp int;\n#define texture2D margoFetch\n#define texture2DProj margoFetchProj\nin vec2 v_uv;out vec4 outputColor;\n' +
          declarations +
          '\n' +
          oracleFetch +
          '\nvec4 getFromColor(vec2 uv){return margoFetch(from,uv);}vec4 getToColor(vec2 uv){return margoFetch(to,uv);}\n' +
          nativeSource +
          '\nvoid main(){outputColor=transition(v_uv);}',
      );
      const program = gl.createProgram();
      programs.push(program);
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      assert(gl.getProgramParameter(program, gl.LINK_STATUS), fixture.name + ': ' + gl.getProgramInfoLog(program));
      gl.useProgram(program);
      const location = gl.getAttribLocation(program, 'position');
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
      gl.uniform1i(gl.getUniformLocation(program, 'from'), 0);
      gl.uniform1i(gl.getUniformLocation(program, 'to'), 1);
      gl.uniform1f(gl.getUniformLocation(program, 'ratio'), W / H);
      for (const [name, v] of Object.entries(fixture.uniforms ?? {})) {
        const loc = gl.getUniformLocation(program, name);
        let type;
        for (let i = 0; i < gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); i++) {
          const info = gl.getActiveUniform(program, i);
          if (info.name.replace(/\[0\]$/, '') === name) type = info.type;
        }
        if (Array.isArray(v)) {
          if ([gl.FLOAT_MAT2, gl.FLOAT_MAT3, gl.FLOAT_MAT4].includes(type))
            gl['uniformMatrix' + { [gl.FLOAT_MAT2]: 2, [gl.FLOAT_MAT3]: 3, [gl.FLOAT_MAT4]: 4 }[type] + 'fv'](
              loc,
              false,
              v,
            );
          else if ([gl.BOOL_VEC2, gl.BOOL_VEC3, gl.BOOL_VEC4, gl.INT_VEC2, gl.INT_VEC3, gl.INT_VEC4].includes(type))
            gl['uniform' + v.length + 'iv'](loc, v.map(Number));
          else if (type === gl.FLOAT) gl.uniform1fv(loc, v);
          else gl['uniform' + v.length + 'fv'](loc, v);
        } else if (typeof v === 'boolean') gl.uniform1i(loc, +v);
        else gl.uniform1f(loc, v);
      }
      const wgsl = translateGLSLTransition(fixture.source, { uniforms: fixture.uniforms });
      const module = d.createShaderModule({
        code:
          header +
          wgsl +
          '@fragment fn fragment(i:Vertex)->@location(0) vec4f{return transition(before,after,i.uv,settings.x);}',
      });
      const pipeline = await d.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba8unorm' }] },
      });
      const group = d.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: settings } },
          { binding: 1, resource: images[0].createView() },
          { binding: 2, resource: images[1].createView() },
        ],
      });
      for (const p of [0.25, 0.5, 0.75]) {
        gl.uniform1f(gl.getUniformLocation(program, 'progress'), p);
        gl.viewport(0, 0, W, H);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const expected = new Uint8Array(W * H * 4);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, expected);
        assert(gl.getError() === gl.NO_ERROR, 'native oracle GL errors');
        d.queue.writeBuffer(settings, 0, new Float32Array([p, 0, 0, 0]));
        const encoder = d.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store' }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.draw(3);
        pass.end();
        const read = d.createBuffer({ size: 256 * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        try {
          encoder.copyTextureToBuffer({ texture: target }, { buffer: read, bytesPerRow: 256 }, [W, H]);
          d.queue.submit([encoder.finish()]);
          await read.mapAsync(GPUMapMode.READ);
          const actual = new Uint8Array(read.getMappedRange());
          for (let y = 0; y < H; y++)
            for (let x = 0; x < W; x++) {
              for (let c = 0; c < 4; c++) {
                const want = expected[((H - 1 - y) * W + x) * 4 + c],
                  got = actual[y * 256 + x * 4 + c];
                assert(Math.abs(want - got) <= 1, `${fixture.name} p=${p} ${x},${y},${c}: native=${want} WGSL=${got}`);
              }
              pixels++;
            }
        } finally {
          read.destroy();
        }
      }
      gl.disableVertexAttribArray(location);
      const frozen = await createGLSLTransition(engine, fixture.source, { uniforms: fixture.uniforms });
      engine.render();
      frozen.start('wipe');
      engine.render({ delta: 0.5 });
      frozen.dispose();
      const a = engine.createScene(),
        b = engine.createScene();
      a.background = '#ff0000';
      b.background = '#0000ff';
      const live = await createLiveGLSLTransition(engine, a, b, fixture.source, { uniforms: fixture.uniforms });
      live.start();
      live.render({ delta: 0.5, target });
      live.dispose();
      a.dispose();
      b.dispose();
    }
    assert(!errors.length, errors.join('\n'));
  } finally {
    for (const b of buffers) b.destroy();
    for (const t of textures) t.destroy();
    for (const p of programs) gl.deleteProgram(p);
    for (const s of shaders) gl.deleteShader(s);
    gl.deleteBuffer(vertex);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    engine.dispose();
  }
  return { glslPixels: pixels, glslFixtures: glslFixtures.length };
}
