import{i as e,n as t,o as n,r,s as i,t as a}from"./index-CFuw7zBN.js";var o=`#version 300 es
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
}`,f=class{constructor(e,t,n,i){this.gl=e,this.rgba=t,this.slots=new Map,this.generation=0,this.texture=null,this.layers=0,this.packer=new r(n,i,1)}get size(){return this.packer.size}bind(e){let t=this.gl;t.activeTexture(t.TEXTURE0+e),this.texture||this.allocate(0),t.bindTexture(t.TEXTURE_2D_ARRAY,this.texture)}place(e){let t=this.slots.get(e);if(t)return t;let r=this.packer.pack(e.width,e.height);if(!r)throw n(`Glyph atlas is full (${this.packer.maxPages} pages of ${this.size}px); raise maxPages or atlasSize in UiRenderer options`,`ui`);return t=r,this.slots.set(e,t),t.page>=this.layers?this.allocate(Math.min(this.packer.maxPages,Math.max(t.page+1,this.layers*2))):this.upload(e,t),t}release(e){return t(this.slots,this.packer,e)!==void 0}allocate(e){let t=this.gl,n=e?this.size:1;if(this.texture&&t.deleteTexture(this.texture),this.texture=t.createTexture(),t.bindTexture(t.TEXTURE_2D_ARRAY,this.texture),t.texStorage3D(t.TEXTURE_2D_ARRAY,1,this.rgba?t.RGBA8:t.R8,n,n,Math.max(1,e)),t.texParameteri(t.TEXTURE_2D_ARRAY,t.TEXTURE_MIN_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D_ARRAY,t.TEXTURE_MAG_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D_ARRAY,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D_ARRAY,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE),this.layers=e,e&&this.generation++,e)for(let[e,t]of this.slots)this.upload(e,t)}upload(e,t){let n=this.gl;n.bindTexture(n.TEXTURE_2D_ARRAY,this.texture),n.bindBuffer(n.PIXEL_UNPACK_BUFFER,null),n.pixelStorei(n.UNPACK_ALIGNMENT,1),n.pixelStorei(n.UNPACK_ROW_LENGTH,0),n.pixelStorei(n.UNPACK_SKIP_ROWS,0),n.pixelStorei(n.UNPACK_SKIP_PIXELS,0),n.pixelStorei(n.UNPACK_SKIP_IMAGES,0),n.pixelStorei(n.UNPACK_IMAGE_HEIGHT,0),n.pixelStorei(n.UNPACK_FLIP_Y_WEBGL,!1),n.pixelStorei(n.UNPACK_PREMULTIPLY_ALPHA_WEBGL,!1),n.texSubImage3D(n.TEXTURE_2D_ARRAY,0,t.x,t.y,t.page,e.width,e.height,1,this.rgba?n.RGBA:n.RED,n.UNSIGNED_BYTE,e.data)}dispose(){this.texture&&this.gl.deleteTexture(this.texture),this.texture=null,this.layers=0,this.slots.clear()}},p=class{constructor(e,t,n){this.gl=e,this.stats=n,this.batch=new a,this.uploaded=-1,this.uploadedAtlas=``;let r=e.getParameter(e.MAX_TEXTURE_SIZE),i=e.getParameter(e.MAX_ARRAY_TEXTURE_LAYERS);this.sdfAtlas=new f(e,!1,Math.min(t.atlasSize,r),Math.min(t.maxPages,i)),this.colorAtlas=new f(e,!0,Math.min(t.colorAtlasSize,r),Math.min(t.maxPages,i)),this.rect=this.program(c,l),this.glyph=this.program(u,d),e.useProgram(this.glyph.program),e.uniform1i(e.getUniformLocation(this.glyph.program,`sdfAtlas`),0),e.uniform1i(e.getUniformLocation(this.glyph.program,`colorAtlas`),1)}program(e,t){let n=this.gl,r=n.createProgram();for(let[i,a]of[[n.VERTEX_SHADER,e],[n.FRAGMENT_SHADER,t]]){let e=n.createShader(i);n.shaderSource(e,a),n.compileShader(e),n.attachShader(r,e),n.deleteShader(e)}if(n.linkProgram(r),!n.getProgramParameter(r,n.LINK_STATUS)&&!n.isContextLost())throw i(`failed`,`@margoengine/ui could not build its WebGL2 shaders (${n.getProgramInfoLog(r)}); report this with your browser and GPU`,`ui`);let a=n.createVertexArray(),o=n.createBuffer();n.bindVertexArray(a),n.bindBuffer(n.ARRAY_BUFFER,o);for(let e=0;e<4;e++)n.enableVertexAttribArray(e),n.vertexAttribDivisor(e,1);return n.bindVertexArray(null),{program:r,vao:a,buffer:o,frame:n.getUniformLocation(r,`frame`),sdf:n.getUniformLocation(r,`sdf`),capacity:0}}upload(e,t,n){let r=this.gl;r.bindBuffer(r.ARRAY_BUFFER,e.buffer),n>e.capacity&&(e.capacity=Math.max(n,e.capacity*2,1024),r.bufferData(r.ARRAY_BUFFER,e.capacity*4,r.DYNAMIC_DRAW)),n&&r.bufferSubData(r.ARRAY_BUFFER,0,t,0,n)}draw(t,n,r,i=null){let a=this.gl,o=this.batch,s=this.stats;s.rects=s.glyphs=s.drawCalls=s.uploads=0;let c=()=>`${this.sdfAtlas.generation}|${this.colorAtlas.generation}`;if((this.uploaded!==t.version||this.uploadedAtlas!==c())&&(o.build(t,this.sdfAtlas,this.colorAtlas),this.upload(this.rect,o.rects,o.rectCount*16),this.upload(this.glyph,o.glyphs,o.glyphCount*16),s.uploads++,this.uploaded=t.version,this.uploadedAtlas=c()),s.rects=o.rectCount,s.glyphs=o.glyphCount,!o.runs.length)return;let l=a.isEnabled(a.DEPTH_TEST),u=a.isEnabled(a.CULL_FACE);a.bindFramebuffer(a.FRAMEBUFFER,i),a.viewport(0,0,n,r),a.disable(a.DEPTH_TEST),a.disable(a.CULL_FACE),a.enable(a.BLEND),a.blendFuncSeparate(a.ONE,a.ONE_MINUS_SRC_ALPHA,a.ONE,a.ONE_MINUS_SRC_ALPHA),a.blendEquation(a.FUNC_ADD),a.enable(a.SCISSOR_TEST),this.sdfAtlas.bind(0),this.colorAtlas.bind(1),this.uploadedAtlas=c();let d;for(let t of o.runs){let i=t.glyphs?this.glyph:this.rect;t.glyphs,i!==d&&(a.useProgram(i.program),a.uniform4f(i.frame,n,r,0,0),a.uniform2f(i.sdf,e.radius,e.cutoff),a.bindVertexArray(i.vao),a.bindBuffer(a.ARRAY_BUFFER,i.buffer),d=i);let o=t.clip,c=o?Math.max(0,Math.min(n,o[0])):0,l=o?Math.max(0,Math.min(r,o[1])):0,u=o?Math.max(0,Math.min(n-c,o[2]-(c-o[0]))):n,f=o?Math.max(0,Math.min(r-l,o[3]-(l-o[1]))):r;if(u&&f){a.scissor(c,r-l-f,u,f);for(let e=0;e<4;e++)a.vertexAttribPointer(e,4,a.FLOAT,!1,64,t.first*64+e*16);a.drawArraysInstanced(a.TRIANGLES,0,6,t.count),s.drawCalls++}}a.bindVertexArray(null),a.disable(a.SCISSOR_TEST),a.disable(a.BLEND),l&&a.enable(a.DEPTH_TEST),u&&a.enable(a.CULL_FACE)}dispose(){let e=this.gl;for(let t of[this.rect,this.glyph])e.deleteProgram(t.program),e.deleteVertexArray(t.vao),e.deleteBuffer(t.buffer);this.sdfAtlas.dispose(),this.colorAtlas.dispose()}},m=(...e)=>new p(...e);export{m as glPainter};