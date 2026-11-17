// The "film" side of the scene: a moving camera path, depth of field,
// bloom, grain and vignette. All of it is evaluated from scroll progress, so
// the visitor is effectively scrubbing through a cutscene.
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { N_LEAVES, T, spreadWindow } from './timeline.js';

/* ---------- camera choreography ---------- */

// Shots, in scroll order. pos = where the camera is, tgt = what it looks at.
function buildShots() {
  const shots = [
    // arrival: low and close across the leather, then rising around the book
    { p: 0.0, pos: [1.35, 1.4, 2.5], tgt: [0, 0.42, 0] },
    { p: 0.06, pos: [0.9, 1.15, 2.8], tgt: [0, 0.24, 0] },
    { p: 0.11, pos: [0.2, 1.3, 2.9], tgt: [0, 0.15, 0] },
    // awakening: swing to the open side to watch the cover lift
    { p: 0.16, pos: [1.5, 1.3, 3.1], tgt: [-0.15, 0.3, 0] },
    { p: 0.21, pos: [0.9, 2.5, 2.7], tgt: [0, 0.15, 0.05] },
  ];
  // the Word: settle over each spread to read, dip low for every page turn
  for (let k = 0; k <= N_LEAVES; k++) {
    const [a, b] = spreadWindow(k);
    const side = k % 2 ? -1 : 1;
    shots.push({ p: (k === 0 ? 0.27 : a) + 0.008, pos: [0.22 * side, 3.55, 2.5], tgt: [0, 0, 0.12] });
    shots.push({ p: b - 0.008, pos: [0.1 * side, 3.38, 2.38], tgt: [0, 0, 0.12] });
    if (k < N_LEAVES) {
      const mid = T.firstTurn + k * T.turnEvery + T.turnLength / 2;
      shots.push({ p: mid, pos: [0.75 * side, 2.7, 2.9], tgt: [0, 0.16, 0.08] });
    }
  }
  // direction and invitation: pull back and rise as the light comes up
  shots.push({ p: 0.86, pos: [-1.8, 2.2, 4.4], tgt: [0, 0.1, 0] });
  shots.push({ p: 0.93, pos: [-0.6, 4.4, 5.0], tgt: [0, 0, -0.1] });
  shots.push({ p: 1.0, pos: [0, 5.8, 4.6], tgt: [0, 0, -0.3] });
  return shots;
}

export class CameraPath {
  constructor() {
    this.shots = buildShots();
    const curve = (key) => new THREE.CatmullRomCurve3(this.shots.map((s) => new THREE.Vector3(...s[key])), false, 'centripetal');
    this.pos = curve('pos');
    this.tgt = curve('tgt');
  }

  // Smooth, continuous motion through every shot for scroll progress P.
  at(P, outPos, outTgt) {
    const s = this.shots, n = s.length;
    let i = 0;
    while (i < n - 2 && P > s[i + 1].p) i++;
    const f = Math.min(1, Math.max(0, (P - s[i].p) / (s[i + 1].p - s[i].p)));
    const t = (i + f) / (n - 1);
    this.pos.getPoint(t, outPos);
    this.tgt.getPoint(t, outTgt);
  }
}

/* ---------- scene render + depth of field ---------- */

const DOF_FRAGMENT = /* glsl */ `
#include <packing>
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform float uNear, uFar, uFocus, uRange, uMaxBlur, uTaps;
uniform vec2 uTexel;
varying vec2 vUv;

float coc(vec2 uv) {
  float z = -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, uNear, uFar);
  return clamp((abs(z - uFocus) - uRange * 0.5) / uRange, 0.0, 1.0);
}

void main() {
  vec4 base = texture2D(tColor, vUv);
  if (uMaxBlur < 0.05) { gl_FragColor = base; return; }
  float c = coc(vUv);
  vec3 acc = base.rgb;
  float total = 1.0;
  for (int i = 1; i <= 26; i++) {
    float fi = float(i);
    if (fi > uTaps) break;
    vec2 o = vec2(cos(fi * 2.39996323), sin(fi * 2.39996323)) * sqrt(fi / uTaps);
    vec2 uv = vUv + o * uTexel * uMaxBlur * c;
    // out-of-focus samples may spread; sharp ones must not bleed outward
    float w = smoothstep(0.0, max(c, 0.001), coc(uv) + 0.12);
    acc += texture2D(tColor, uv).rgb * w;
    total += w;
  }
  gl_FragColor = vec4(acc / total, 1.0);
}`;

const QUAD_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

class SceneDofPass extends Pass {
  constructor(scene, camera, samples) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples });
    this.target.depthTexture = new THREE.DepthTexture(4, 4);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: this.target.texture },
        tDepth: { value: this.target.depthTexture },
        uNear: { value: camera.near },
        uFar: { value: camera.far },
        uFocus: { value: 4 },
        uRange: { value: 1 },
        uMaxBlur: { value: 0 },
        uTaps: { value: 22 },
        uTexel: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: QUAD_VERTEX,
      fragmentShader: DOF_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  setSize(w, h) {
    this.target.setSize(w, h);
    this.material.uniforms.uTexel.value.set(1 / w, 1 / h);
  }

  render(renderer, writeBuffer) {
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
}

/* ---------- film finish: lens fringing, vignette, grain ---------- */

const FilmShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 0.8 },
    uGrain: { value: 0.04 },
    uFringe: { value: 0.006 },
  },
  vertexShader: QUAD_VERTEX,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uTime, uVignette, uGrain, uFringe;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 c = vUv - 0.5;
  float d = dot(c, c);
  vec2 off = c * d * uFringe;
  vec3 col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
  float v = smoothstep(0.95, 0.25, length(c) * 1.35);
  col *= mix(1.0, v, uVignette);
  col += (hash(vUv * 937.0 + uTime) - 0.5) * uGrain;
  gl_FragColor = vec4(col, 1.0);
}`,
};

export class FilmPipeline {
  constructor(renderer, scene, camera, { mobile }) {
    this.renderer = renderer;
    this.mobile = mobile;
    this.composer = new EffectComposer(renderer);
    this.dof = new SceneDofPass(scene, camera, mobile ? 0 : 4);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.22, 0.55, 1.0);
    this.film = new ShaderPass(FilmShader);
    this.taps = mobile ? 0 : 22;
    this.composer.addPass(this.dof);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    // cheap edge smoothing for quality levels that skip multisampling
    this.fxaa = new ShaderPass(FXAAShader);
    this.composer.addPass(this.fxaa);
    this.composer.addPass(this.film);
  }

  setSize(w, h) {
    this.composer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    this.fxaa.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
  }

  // samples: edge smoothing. taps: bokeh quality, 0 turns depth of field off.
  setQuality({ pixelRatio, samples, taps }) {
    this.composer.setPixelRatio(pixelRatio);
    this.taps = taps;
    this.fxaa.enabled = samples === 0;
    this.dof.material.uniforms.uTaps.value = Math.max(1, taps);
    if (this.dof.target.samples !== samples) {
      this.dof.target.samples = samples;
      this.dof.target.dispose();
    }
  }

  // focus: distance to the subject. blur: bokeh radius in CSS pixels.
  render({ focus, range, blur, bloom, vignette, grain, time }) {
    const u = this.dof.material.uniforms;
    u.uFocus.value = focus;
    u.uRange.value = range;
    u.uMaxBlur.value = this.taps > 0 ? blur * this.renderer.getPixelRatio() : 0;
    this.bloom.strength = bloom;
    const f = this.film.uniforms;
    f.uVignette.value = vignette;
    f.uGrain.value = grain;
    f.uTime.value = time;
    this.composer.render();
  }
}
