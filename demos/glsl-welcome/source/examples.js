export const header = `#version 300 es
precision highp float;
in vec2 uv;
uniform float phase;
out vec4 color;

void main() {`;

export const examples = {
  silk: {
    title: 'Iridescent silk',
    source: `${header}
  vec2 p = uv - 0.5;
  float a = 0.64 + phase * 2.0;
  vec2 q = vec2(p.x*cos(a) - p.y*sin(a),
                p.x*sin(a) + p.y*cos(a));
  float bend = q.x + 0.22*sin(q.y*5.4)
                + 0.12*cos(q.y*9.0 + q.x*1.4);
  float wave = bend*12.4 + 0.85*sin(q.y*4.1);
  float sheen = 0.5 + 0.5*cos(wave + 0.3);
  vec3 ink = vec3(0.095, 0.22, 0.18);
  vec3 warm = vec3(0.97, 0.64, 0.32);
  vec3 cool = vec3(0.56, 0.88, 0.71);
  vec3 dye = mix(warm, cool, 0.5 + 0.5*sin(wave*0.73 + 1.0));
  vec3 lit = mix(ink, dye, smoothstep(0.04, 0.91, sheen));
  float thread = sin(bend*265.0 - q.y*22.0);
  float crossgrain = sin(q.y*273.0 + 0.9*sin(bend*33.0));
  float grain = 0.027*thread + 0.014*crossgrain + 0.022*thread*crossgrain;
  float glint = 0.14*pow(sheen, 8.0);
  float falloff = 1.0 - 0.35*dot(p, p);
  color = vec4((lit + grain + glint)*falloff, 1.0);
}`,
  },
  signal: {
    title: 'Signal interference',
    source: `${header}
  vec2 p = uv - 0.5;
  vec2 q = p + 0.082*sin(p.yx*10.5 + phase*5.0);
  float carrier = sin(q.x*46.0)*sin(q.y*46.0);
  float echo = sin((q.x+q.y)*33.0)*cos((q.x-q.y)*32.0);
  float edge = smoothstep(-0.07, 0.07, carrier + 0.65*echo);
  float bloom = 1.0 - smoothstep(0.08, 0.69, length(p - vec2(-0.16, 0.14)));
  vec3 night = mix(vec3(0.14, 0.18, 0.42), vec3(0.29, 0.40, 0.73), bloom);
  vec3 enamel = mix(vec3(0.82, 0.33, 0.22), vec3(0.98, 0.79, 0.55), bloom);
  color = vec4(mix(night, enamel, edge), 1.0);
}`,
  },
  petal: {
    title: 'Petal aperture',
    source: `${header}
  vec2 p = uv - vec2(0.51, 0.46);
  float r = length(p);
  float a = atan(p.y, p.x + 0.000001);
  float profile = 0.24 + 0.055*cos(a*7.0 + phase*6.28);
  float front = r / profile;
  float thread = 0.5 + 0.5*cos(front*97.0 - a*7.0);
  float mask = 1.0 - smoothstep(0.98, 1.02, front);
  vec3 ground = vec3(0.94, 0.80, 0.69) - 0.16*r;
  vec3 red = mix(vec3(0.54, 0.10, 0.19), vec3(0.98, 0.56, 0.35), pow(thread, 1.6));
  red = mix(vec3(0.30, 0.07, 0.12), red, smoothstep(0.0, 0.38, front));
  color = vec4(mix(ground, red, mask), 1.0);
}`,
  },
};
