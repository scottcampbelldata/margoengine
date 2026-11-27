import{a as e,f as t,o as n,p as r,r as i,u as a}from"./dom-CWJhpotq-B6hIpuZc.js";var o=`#version 300 es
precision highp float;
precision highp int;
`,s=`uniform vec4 frame; // width, height, linear, 0
uniform vec2 sdf;
vec2 corner(int vi) { return vec2(float((0x32 >> vi) & 1), float((0x2c >> vi) & 1)); }
vec4 ndc(vec2 p) { return vec4(p.x / frame.x * 2.0 - 1.0, 1.0 - p.y / frame.y * 2.0, 0.0, 1.0); }
vec3 toLinear(vec3 c) { return mix(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, vec3(lessThanEqual(c, vec3(0.04045)))); }
vec4 prep(vec4 c) { vec3 rgb = frame.z > 0.5 ? toLinear(c.rgb) : c.rgb; return vec4(rgb * c.a, c.a); }
`,c=`${o}${s}
layout(location = 0) in vec4 box;
layout(location = 1) in vec4 fill;
layout(location = 2) in vec4 border;
layout(location = 3) in vec4 params;
out vec2 local;
flat out vec4 vBox;
flat out vec4 vFill;
flat out vec4 vBorder;
flat out vec4 vParams;
void main() {
  float pad = params.z * 2.0 + 2.0;
  vec2 p = mix(box.xy - vec2(pad), box.xy + box.zw + vec2(pad), corner(gl_VertexID));
  gl_Position = ndc(p);
  local = p - (box.xy + box.zw * 0.5);
  vBox = box; vFill = fill; vBorder = border; vParams = params;
}`,l=`${o}${s}
in vec2 local;
flat in vec4 vBox;
flat in vec4 vFill;
flat in vec4 vBorder;
flat in vec4 vParams;
out vec4 color;
void main() {
  vec2 ext = vBox.zw * 0.5;
  float radius = min(vParams.x, min(ext.x, ext.y));
  vec2 q = abs(local) - ext + vec2(radius);
  float d = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - radius;
  float cover = clamp(0.5 - d, 0.0, 1.0);
  if (vParams.z > 0.0) cover = 1.0 - smoothstep(-vParams.z, vParams.z, d);
  float inner = 1.0;
  if (vParams.y > 0.0) inner = clamp(0.5 - (d + vParams.y), 0.0, 1.0);
  color = mix(prep(vBorder), prep(vFill), inner) * cover;
}`,u=`${o}${s}
layout(location = 0) in vec4 box;
layout(location = 1) in vec4 uv;
layout(location = 2) in vec4 tint;
layout(location = 3) in vec4 info;
out vec2 vUv;
flat out vec4 vTint;
flat out vec4 vInfo;
void main() {
  vec2 c = corner(gl_VertexID);
  gl_Position = ndc(mix(box.xy, box.zw, c));
  vUv = vec2(mix(uv.x, uv.z, c.x), mix(uv.y, uv.w, c.y));
  vTint = tint; vInfo = info;
}`,d=`${o}${s}
uniform highp sampler2DArray sdfAtlas;
uniform highp sampler2DArray colorAtlas;
in vec2 vUv;
flat in vec4 vTint;
flat in vec4 vInfo;
out vec4 color;
void main() {
  vec2 texels = vUv * vec2(textureSize(sdfAtlas, 0).xy);
  float w = max(0.5 * (length(dFdx(texels)) + length(dFdy(texels))), 1e-3);
  float texel = textureLod(sdfAtlas, vec3(vUv, vInfo.x), 0.0).r;
  vec4 t = textureLod(colorAtlas, vec3(vUv, vInfo.x), 0.0);
  if (vInfo.y > 0.5) {
    if (frame.z > 0.5 && t.a > 0.0) t = vec4(toLinear(t.rgb / t.a) * t.a, t.a);
    if (vInfo.y > 1.5) {
      vec3 tint = frame.z > 0.5 ? toLinear(vTint.rgb) : vTint.rgb;
      color = vec4(t.rgb * tint, t.a) * vTint.a;
      return;
    }
    color = t * vTint.a;
    return;
  }
  float d = ((1.0 - texel) - sdf.y) * sdf.x;
  float field = clamp(texel * 127.5, 0.0, 1.0);
  float cover = clamp(0.5 - (d - vInfo.z * w) / w, 0.0, 1.0) * field;
  color = prep(vec4(vTint.rgb, vTint.a * cover));
}`,f=class{constructor(e,t,r,i){this.gl=e,this.rgba=t,this.slots=new Map,this.generation=0,this.texture=null,this.layers=0,this.packer=new n(r,i,1)}get size(){return this.packer.size}bind(e){let t=this.gl;t.activeTexture(t.TEXTURE0+e),this.texture||this.allocate(0),t.bindTexture(t.TEXTURE_2D_ARRAY,this.texture)}place(e){let n=this.slots.get(e);if(n)return n;let r=this.packer.pack(e.width,e.height);if(!r)throw t(`Glyph atlas is full (${this.packer.maxPages} pages of ${this.size}px); raise maxPages or atlasSize in UiRenderer options`,`ui`);return n=r,this.slots.set(e,n),n.page>=this.layers?this.allocate(Math.min(this.packer.maxPages,Math.max(n.page+1,this.layers*2))):this.upload(e,n),n}release(t){return e(this.slots,this.packer,t)!==void 0}allocate(e){let t=this.gl,n=e?this.size:1;if(this.texture&&t.deleteTexture(this.texture),this.texture=t.createTexture(),t.bindTexture(t.TEXTURE_2D_ARRAY,this.texture),t.texStorage3D(t.TEXTURE_2D_ARRAY,1,this.rgba?t.RGBA8:t.R8,n,n,Math.max(1,e)),t.texParameteri(t.TEXTURE_2D_ARRAY,t.TEXTURE_MIN_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D_ARRAY,t.TEXTURE_MAG_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D_ARRAY,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D_ARRAY,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE),this.layers=e,e&&this.generation++,e)for(let[e,t]of this.slots)this.upload(e,t)}upload(e,t){let n=this.gl;n.bindTexture(n.TEXTURE_2D_ARRAY,this.texture),n.bindBuffer(n.PIXEL_UNPACK_BUFFER,null),n.pixelStorei(n.UNPACK_ALIGNMENT,1),n.pixelStorei(n.UNPACK_ROW_LENGTH,0),n.pixelStorei(n.UNPACK_SKIP_ROWS,0),n.pixelStorei(n.UNPACK_SKIP_PIXELS,0),n.pixelStorei(n.UNPACK_SKIP_IMAGES,0),n.pixelStorei(n.UNPACK_IMAGE_HEIGHT,0),n.pixelStorei(n.UNPACK_FLIP_Y_WEBGL,!1),n.pixelStorei(n.UNPACK_PREMULTIPLY_ALPHA_WEBGL,!1),n.texSubImage3D(n.TEXTURE_2D_ARRAY,0,t.x,t.y,t.page,e.width,e.height,1,this.rgba?n.RGBA:n.RED,n.UNSIGNED_BYTE,e.data)}dispose(){this.texture&&this.gl.deleteTexture(this.texture),this.texture=null,this.layers=0,this.slots.clear()}},p=class{constructor(e,t,n){this.gl=e,this.stats=n,this.batch=new i,this.uploaded=-1,this.uploadedAtlas=``;let r=e.getParameter(e.MAX_TEXTURE_SIZE),a=e.getParameter(e.MAX_ARRAY_TEXTURE_LAYERS);this.sdfAtlas=new f(e,!1,Math.min(t.atlasSize,r),Math.min(t.maxPages,a)),this.colorAtlas=new f(e,!0,Math.min(t.colorAtlasSize,r),Math.min(t.maxPages,a)),this.rect=this.program(c,l),this.glyph=this.program(u,d),e.useProgram(this.glyph.program),e.uniform1i(e.getUniformLocation(this.glyph.program,`sdfAtlas`),0),e.uniform1i(e.getUniformLocation(this.glyph.program,`colorAtlas`),1)}program(e,t){let n=this.gl,i=n.createProgram();for(let[r,a]of[[n.VERTEX_SHADER,e],[n.FRAGMENT_SHADER,t]]){let e=n.createShader(r);n.shaderSource(e,a),n.compileShader(e),n.attachShader(i,e),n.deleteShader(e)}if(n.linkProgram(i),!n.getProgramParameter(i,n.LINK_STATUS)&&!n.isContextLost())throw r(`failed`,`@margoengine/ui could not build its WebGL2 shaders (${n.getProgramInfoLog(i)}); report this with your browser and GPU`,`ui`);let a=n.createVertexArray(),o=n.createBuffer();n.bindVertexArray(a),n.bindBuffer(n.ARRAY_BUFFER,o);for(let e=0;e<4;e++)n.enableVertexAttribArray(e),n.vertexAttribDivisor(e,1);return n.bindVertexArray(null),{program:i,vao:a,buffer:o,frame:n.getUniformLocation(i,`frame`),sdf:n.getUniformLocation(i,`sdf`),capacity:0}}upload(e,t,n){let r=this.gl;r.bindBuffer(r.ARRAY_BUFFER,e.buffer),n>e.capacity&&(e.capacity=Math.max(n,e.capacity*2,1024),r.bufferData(r.ARRAY_BUFFER,e.capacity*4,r.DYNAMIC_DRAW)),n&&r.bufferSubData(r.ARRAY_BUFFER,0,t,0,n)}draw(e,t,n,r=null){let i=this.gl,o=this.batch,s=this.stats;s.rects=s.glyphs=s.drawCalls=s.uploads=0;let c=()=>`${this.sdfAtlas.generation}|${this.colorAtlas.generation}`;if((this.uploaded!==e.version||this.uploadedAtlas!==c())&&(o.build(e,this.sdfAtlas,this.colorAtlas),this.upload(this.rect,o.rects,o.rectCount*16),this.upload(this.glyph,o.glyphs,o.glyphCount*16),s.uploads++,this.uploaded=e.version,this.uploadedAtlas=c()),s.rects=o.rectCount,s.glyphs=o.glyphCount,!o.runs.length)return;let l=i.isEnabled(i.DEPTH_TEST),u=i.isEnabled(i.CULL_FACE);i.bindFramebuffer(i.FRAMEBUFFER,r),i.viewport(0,0,t,n),i.disable(i.DEPTH_TEST),i.disable(i.CULL_FACE),i.enable(i.BLEND),i.blendFuncSeparate(i.ONE,i.ONE_MINUS_SRC_ALPHA,i.ONE,i.ONE_MINUS_SRC_ALPHA),i.blendEquation(i.FUNC_ADD),i.enable(i.SCISSOR_TEST),this.sdfAtlas.bind(0),this.colorAtlas.bind(1),this.uploadedAtlas=c();let d;for(let e of o.runs){let r=e.glyphs?this.glyph:this.rect;e.glyphs,r!==d&&(i.useProgram(r.program),i.uniform4f(r.frame,t,n,0,0),i.uniform2f(r.sdf,a.radius,a.cutoff),i.bindVertexArray(r.vao),i.bindBuffer(i.ARRAY_BUFFER,r.buffer),d=r);let o=e.clip,c=o?Math.max(0,Math.min(t,o[0])):0,l=o?Math.max(0,Math.min(n,o[1])):0,u=o?Math.max(0,Math.min(t-c,o[2]-(c-o[0]))):t,f=o?Math.max(0,Math.min(n-l,o[3]-(l-o[1]))):n;if(u&&f){i.scissor(c,n-l-f,u,f);for(let t=0;t<4;t++)i.vertexAttribPointer(t,4,i.FLOAT,!1,64,e.first*64+t*16);i.drawArraysInstanced(i.TRIANGLES,0,6,e.count),s.drawCalls++}}i.bindVertexArray(null),i.disable(i.SCISSOR_TEST),i.disable(i.BLEND),l&&i.enable(i.DEPTH_TEST),u&&i.enable(i.CULL_FACE)}dispose(){let e=this.gl;for(let t of[this.rect,this.glyph])e.deleteProgram(t.program),e.deleteVertexArray(t.vao),e.deleteBuffer(t.buffer);this.sdfAtlas.dispose(),this.colorAtlas.dispose()}},m=(...e)=>new p(...e);export{m as glPainter};