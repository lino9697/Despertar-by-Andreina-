// The 3D Bible. Everything here is a pure function of scroll progress:
// update(P) poses the book, pages, camera and light for that exact position,
// so scrolling backward replays the same frames in reverse.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { CameraPath, FilmPipeline } from './cinema.js';
import scripture from './data/scripture.json';
import { N_LEAVES, T, clamp01, lerp, smooth, smoother, range, turnProgress } from './timeline.js';
import {
  makeCanvas, loadPageFonts, leatherColorCanvas, leatherBumpCanvas, edgeCanvas,
  drawCover, drawDisplayPage, drawContextPage, setPaperPhoto,
} from './textures.js';

/* ---------- book dimensions (page width = 1) ---------- */
const PW = 1.0;            // page width
const PH = 1.46;           // page height
const S = 0.21;            // thickness of the page block (= spine width)
const CT = 0.022;          // cover thickness
const CW = PW + 0.04;      // cover width (overhang past the pages)
const CH = PH + 0.08;      // cover height
const EPS = 0.0016;        // spacing between loose leaves
const TL = 0.08;           // pages that open with the front cover
const TR = S - TL - (N_LEAVES + 1) * EPS; // pages that stay on the back cover
const ALPHA = 1.15;        // how steeply pages rise out of the gutter
const NS = 48;             // segments across a page
const DS = PW / NS;
const BELLY = 0.045;        // how much open pages arch down toward the fore-edge
const FLEX = 0.05;         // how much the front cover bows while opening

// Sine integral: gives the height a page reaches when its slope decays
// exponentially away from the gutter.
function sineIntegral(x) {
  let sum = 0, term = x;
  for (let k = 0; k < 12; k++) {
    sum += term / (2 * k + 1);
    term *= (-x * x) / ((2 * k + 2) * (2 * k + 3));
  }
  return sum;
}

// Slope of a page lying on a stack that rises `rise` out of the gutter.
function restAngles(out, rise, alpha) {
  if (rise < 1e-5 || alpha < 1e-4) return out.fill(0);
  const lambda = rise / sineIntegral(alpha);
  const belly = BELLY * (alpha / ALPHA);
  for (let i = 0; i < NS; i++) {
    const e = Math.exp(-((i + 0.5) * DS) / lambda);
    out[i] = alpha * e - belly * (1 - e);
  }
  return out;
}

const tmpA = new Float32Array(NS);
const tmpB = new Float32Array(NS);

function sheetIndex() {
  const idx = [];
  for (let i = 0; i < NS; i++) {
    const a = i * 2, b = (i + 1) * 2, c = i * 2 + 1, d = (i + 1) * 2 + 1;
    idx.push(a, c, b, b, c, d);
  }
  return idx;
}

function sheetGeometry() {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array((NS + 1) * 2 * 3);
  const uv = new Float32Array((NS + 1) * 2 * 2);
  for (let i = 0; i <= NS; i++) {
    uv.set([i / NS, 1, i / NS, 0], i * 4);
    pos[i * 6 + 2] = -PH / 2;
    pos[i * 6 + 5] = PH / 2;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(sheetIndex());
  return geo;
}

/* ---------- a stack of pages (solid block with a printed top face) ---------- */
class PageStack {
  constructor(thickness, faceMaterial, edgeMaterial) {
    this.t = thickness;
    this.group = new THREE.Group();
    this.topGeo = sheetGeometry();
    this.top = new THREE.Mesh(this.topGeo, faceMaterial);
    this.top.receiveShadow = true;

    // head cap, tail cap, fore-edge
    const n = (NS + 1) * 2;
    this.edgeGeo = new THREE.BufferGeometry();
    this.edgeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((n * 2 + 4) * 3), 3));
    this.edgeGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array((n * 2 + 4) * 2), 2));
    const idx = [];
    for (let cap = 0; cap < 2; cap++) {
      const o = cap * n;
      for (let i = 0; i < NS; i++) {
        const a = o + i * 2, b = o + (i + 1) * 2, c = a + 1, d = b + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const f = n * 2;
    idx.push(f, f + 1, f + 2, f + 2, f + 1, f + 3);
    this.edgeGeo.setIndex(idx);
    this.edge = new THREE.Mesh(this.edgeGeo, edgeMaterial);
    this.edge.castShadow = true;
    this.edge.receiveShadow = true;
    this.group.add(this.top, this.edge);
    this.key = '';
  }

  // o: how far the book is open (0..1). flex: bow of the cover it sits on.
  update(o, flex) {
    const key = o.toFixed(5) + '|' + flex.toFixed(5);
    if (key === this.key) return;
    this.key = key;
    const t = this.t;
    const ang = restAngles(tmpA, t * o, ALPHA * o);
    const top = this.topGeo.attributes.position.array;
    const e = this.edgeGeo.attributes.position.array;
    const euv = this.edgeGeo.attributes.uv.array;
    const n = (NS + 1) * 2;
    const K = 5.5;
    const gx = (-S / 2) * o;
    let x = gx, y = t * (1 - o);
    let lastX = x, lastTop = y, lastBottom = 0, lastXb = x;
    for (let i = 0; i <= NS; i++) {
      const xb = gx + (i / NS) * PW;
      const bow = flex * Math.pow(Math.max(0, x) / CW, 2);
      const yt = y + bow, yb = flex * Math.pow(Math.max(0, xb) / CW, 2);
      if (i === 3) { this.ribbonX = x; this.ribbonY = yt; this.ribbonTilt = ang[i]; }
      top[i * 6] = x; top[i * 6 + 1] = yt;
      top[i * 6 + 3] = x; top[i * 6 + 4] = yt;
      for (let cap = 0; cap < 2; cap++) {
        const z = cap === 0 ? -PH / 2 : PH / 2;
        const p = (cap * n + i * 2) * 3, q = (cap * n + i * 2) * 2;
        e[p] = x; e[p + 1] = yt; e[p + 2] = z;
        e[p + 3] = xb; e[p + 4] = yb; e[p + 5] = z;
        euv[q] = x; euv[q + 1] = yt * K;
        euv[q + 2] = xb; euv[q + 3] = yb * K;
      }
      lastX = x; lastTop = yt; lastBottom = yb; lastXb = xb;
      if (i < NS) { x += Math.cos(ang[i]) * DS; y += Math.sin(ang[i]) * DS; }
    }
    const p = n * 2 * 3, q = n * 2 * 2;
    e.set([lastX, lastTop, -PH / 2, lastX, lastTop, PH / 2, lastXb, lastBottom, -PH / 2, lastXb, lastBottom, PH / 2], p);
    euv.set([0, lastTop * K, 1, lastTop * K, 0, lastBottom * K, 1, lastBottom * K], q);
    this.topGeo.attributes.position.needsUpdate = true;
    this.edgeGeo.attributes.position.needsUpdate = true;
    this.edgeGeo.attributes.uv.needsUpdate = true;
    this.topGeo.computeVertexNormals();
    this.edgeGeo.computeVertexNormals();
  }
}

/* ---------- a single leaf that bends as it turns ---------- */
class Leaf {
  constructor(index, frontMaterial, backMaterial) {
    this.restRight = TR + (N_LEAVES - index) * EPS;
    this.restLeft = TL + (index + 1) * EPS;
    this.geo = sheetGeometry();
    this.front = new THREE.Mesh(this.geo, frontMaterial);
    this.back = new THREE.Mesh(this.geo, backMaterial);
    this.front.castShadow = true;
    this.front.receiveShadow = true;
    this.back.receiveShadow = true;
    this.group = new THREE.Group();
    this.group.add(this.front, this.back);
    this.key = '';
  }

  // p: how far this leaf has turned (0 = lying right, 1 = lying left).
  update(p, o) {
    const key = p.toFixed(5) + '|' + o.toFixed(5);
    if (key === this.key) return;
    this.key = key;
    const right = restAngles(tmpA, this.restRight * o, ALPHA * o);
    const left = restAngles(tmpB, this.restLeft, ALPHA);
    const e = smoother(p);
    // Paper sags under its own weight: the free edge trails on the way up
    // and leads on the way down.
    const sag = 1.25 * Math.pow(Math.sin(Math.PI * e), 2) * Math.cos(Math.PI * e);
    const pos = this.geo.attributes.position.array;
    let x = (-S / 2) * o, y = this.restRight * (1 - o);
    for (let i = 0; i <= NS; i++) {
      pos[i * 6] = x; pos[i * 6 + 1] = y;
      pos[i * 6 + 3] = x; pos[i * 6 + 4] = y;
      if (i < NS) {
        const u = (i + 0.5) / NS;
        const a = right[i] + (Math.PI - left[i] - right[i]) * e - sag * Math.pow(u, 1.4);
        x += Math.cos(a) * DS;
        y += Math.sin(a) * DS;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.computeVertexNormals();
  }
}

/* ---------- ribbon bookmark ---------- */
const RIBBON_SEG = 56;
class Ribbon {
  constructor() {
    const n = RIBBON_SEG + 1;
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
    const idx = [];
    for (let i = 0; i < RIBBON_SEG; i++) {
      const a = i * 2, b = a + 2, c = a + 1, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    this.geo.setIndex(idx);
    this.mesh = new THREE.Mesh(this.geo, new THREE.MeshStandardMaterial({
      color: 0xa8792f, roughness: 0.42, metalness: 0.25, side: THREE.DoubleSide,
    }));
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.curve = new THREE.CatmullRomCurve3([], false, 'centripetal');
    this.key = '';
  }

  // Lies down the page beside the gutter, slips out at the foot of the book
  // and hangs until it reaches the surface the book rests on.
  update(x, y, floorY, tilt) {
    const key = x.toFixed(4) + '|' + y.toFixed(4) + '|' + floorY.toFixed(3) + '|' + tilt.toFixed(3);
    if (key === this.key) return;
    this.key = key;
    const len = 0.17;
    const edge = CH / 2 + 0.004;
    const depth = Math.min(len, Math.max(CT, -floorY));
    const rest = len - depth;
    const V = (px, py, pz) => new THREE.Vector3(px, py, pz);
    const pts = [
      // pages close over the ribbon near the gutter, so it only shows where
      // it slips out at the foot of the book
      V(x, y * 0.9, PH / 2 - 0.012),
      V(x, y * 0.8, PH / 2 + 0.004),
      V(x, 0.004, PH / 2 + 0.028),
      V(x, 0.003, edge),
      V(x + 0.004, -depth * 0.55, edge + 0.014),
      V(x + 0.012, -depth + 0.004, edge + 0.03 + rest * 0.12),
    ];
    if (rest > 0.01) pts.push(V(x + 0.03, -depth + 0.003, edge + 0.03 + rest * 0.6), V(x + 0.022, -depth + 0.003, edge + 0.03 + rest));
    this.curve.points = pts;
    const pos = this.geo.attributes.position.array;
    const p = new THREE.Vector3();
    const w = 0.015;
    for (let i = 0; i <= RIBBON_SEG; i++) {
      this.curve.getPoint(i / RIBBON_SEG, p);
      // lie flush with the sloping page, then flatten once clear of the pages
      const a = tilt * (1 - Math.min(1, Math.max(0, (p.z - PH / 2) / 0.025)));
      const cx = Math.cos(a) * w, cy = Math.sin(a) * w;
      pos.set([p.x - cx, p.y - cy, p.z, p.x + cx, p.y + cy, p.z], i * 6);
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.computeVertexNormals();
  }
}

/* ---------- covers ---------- */
function coverSlab(x0, x1, y0, y1) {
  const geo = new THREE.BoxGeometry(x1 - x0, y1 - y0, CH, 40, 1, 56);
  geo.translate((x0 + x1) / 2, (y0 + y1) / 2, 0);
  const r = 0.05, pos = geo.attributes.position;
  const re = (y1 - y0) * 0.46;          // radius of the rolled leather edge
  const ring = [0, 0.15, 0.5, 1];       // extra rows of vertices inside that radius
  const ym = (y0 + y1) / 2;
  for (let i = 0; i < pos.count; i++) {
    // gather the outer rows of the grid into the rolled edge
    let x = pos.getX(i), z = pos.getZ(i);
    const k = Math.round(((x - x0) / (x1 - x0)) * 40);
    x = k >= 37 ? x1 - re * ring[40 - k] : x0 + (k / 37) * (x1 - re - x0);
    const j = Math.round(((z + CH / 2) / CH) * 56);
    if (j <= 3) z = -CH / 2 + re * ring[j];
    else if (j >= 53) z = CH / 2 - re * ring[56 - j];
    else z = -CH / 2 + re + ((j - 3) / 50) * (CH - 2 * re);
    // round the two outer corners
    const dx = x - (x1 - r), dz = Math.abs(z) - (CH / 2 - r);
    let d;
    if (dx > 0 && dz > 0) {
      const len = Math.hypot(dx, dz);
      if (len > r) {
        x = x1 - r + (dx / len) * r;
        z = Math.sign(z) * (CH / 2 - r + (dz / len) * r);
      }
      d = r - Math.min(len, r);
    } else {
      d = Math.min(x1 - x, CH / 2 - Math.abs(z));
    }
    // roll the top and bottom faces over toward the middle of the edge
    if (d < re) {
      const drop = re - Math.sqrt(Math.max(0, re * re - (re - d) * (re - d)));
      const y = pos.getY(i);
      pos.setY(i, y > ym ? y - drop : y + drop);
    }
    pos.setX(i, x);
    pos.setZ(i, z);
  }
  geo.computeVertexNormals();
  geo.userData.base = pos.array.slice();
  return geo;
}

function bowSlab(geo, amount) {
  const base = geo.userData.base, pos = geo.attributes.position.array;
  for (let i = 0; i < pos.length; i += 3) {
    pos[i + 1] = base[i + 1] + amount * Math.pow(Math.max(0, base[i]) / CW, 2);
  }
  geo.attributes.position.needsUpdate = true;
}

const _pos = new THREE.Vector3();
const _tgt = new THREE.Vector3();

export class BibleScene {
  constructor(canvas, { mobile = false, lang = 'es' } = {}) {
    this.canvas = canvas;
    this.mobile = mobile;
    this.lang = lang;
    this.progress = 0;
    this.intro = 0;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.25 : 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false; // redrawn only when the book actually moves
    this.renderer = renderer;
    this.maxAniso = renderer.capabilities.getMaxAnisotropy();

    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    // the set: darkness that later gives way to warm morning light
    this.bgDark = new THREE.Color(0x0b0806);
    this.bgLight = new THREE.Color(0xc9a274);
    this.scene.background = this.bgDark.clone();
    this.scene.fog = new THREE.Fog(this.bgDark.getHex(), 7, 20);

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 60);
    this.path = new CameraPath();

    // key light: a single warm spotlight from above, like a stage
    const sm = mobile ? 1024 : 2048;
    this.key = new THREE.SpotLight(0xfff0dc, 2, 0, 0.5, 0.9, 0);
    this.key.position.set(-1.3, 6.5, 1.9);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(sm, sm);
    this.key.shadow.camera.near = 2;
    this.key.shadow.camera.far = 12;
    this.key.shadow.bias = -0.0003;
    this.key.shadow.normalBias = 0.015;
    this.key.shadow.radius = 4;
    this.rim = new THREE.PointLight(0xffc98a, 6, 0, 2);
    this.rim.position.set(1.6, 1.3, -2.2);
    // morning: low sun and soft sky fill, faded in near the end
    this.sun = new THREE.DirectionalLight(0xffe2b8, 0);
    this.sun.position.set(4.5, 2.6, -2.5);
    this.sun.castShadow = !mobile;
    this.sun.shadow.mapSize.set(1024, 1024);
    Object.assign(this.sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 1, far: 14 });
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.015;
    this.sun.shadow.radius = 5;
    this.fill = new THREE.HemisphereLight(0xfff1dc, 0x9a8a74, 0);
    this.scene.add(this.key, this.key.target, this.rim, this.sun, this.fill);

    // the surface the Bible rests on
    this.floorDark = new THREE.Color(0x19120c);
    this.floorLight = new THREE.Color(0xefe6d6);
    this.floorMat = new THREE.MeshStandardMaterial({ color: this.floorDark.clone(), roughness: 0.42, metalness: 0 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), this.floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -CT - 0.003;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // visible shaft of light falling from the spotlight
    const beamGeo = new THREE.CylinderGeometry(0.12, 2.9, 7.4, 48, 1, true);
    beamGeo.translate(0, -3.7, 0);
    this.beamMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uColor: { value: new THREE.Color(0xffd9a0) }, uOpacity: { value: 0.12 } },
      vertexShader: `varying vec3 vN; varying vec3 vV; varying float vH;
        void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalMatrix * normal; vV = -mv.xyz; vH = uv.y; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform vec3 uColor; uniform float uOpacity; varying vec3 vN; varying vec3 vV; varying float vH;
        void main() { float f = pow(abs(dot(normalize(vN), normalize(vV))), 3.0);
          gl_FragColor = vec4(uColor, f * smoothstep(0.0, 0.3, vH) * (0.3 + 0.7 * vH) * uOpacity); }`,
    });
    const beam = new THREE.Mesh(beamGeo, this.beamMat);
    beam.position.copy(this.key.position);
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), this.key.position.clone().negate().normalize());
    beam.frustumCulled = false;
    this.scene.add(beam);

    const cc = makeCanvas(256, 256), cx = cc.getContext('2d');
    const cg = cx.createRadialGradient(128, 128, 20, 128, 128, 128);
    cg.addColorStop(0, 'rgba(0,0,0,0.9)');
    cg.addColorStop(0.55, 'rgba(0,0,0,0.5)');
    cg.addColorStop(1, 'rgba(0,0,0,0)');
    cx.fillStyle = cg;
    cx.fillRect(0, 0, 256, 256);
    this.contactMat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cc), transparent: true, depthWrite: false, opacity: 0.5 });
    this.contact = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.contactMat);
    this.contact.rotation.x = -Math.PI / 2;
    this.contact.position.y = -CT - 0.001;
    this.scene.add(this.contact);

    this.film = new FilmPipeline(renderer, this.scene, this.camera, { mobile });

    this.resize();
  }

  // Loads the photo-scanned leather and paper, then builds the book. If the
  // scans cannot be loaded the book falls back to drawn textures.
  async init(lang = this.lang) {
    const image = (name) => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = `/textures/${name}.jpg`;
    });
    try {
      const [leatherColor, leatherNormal, leatherRough, paperColor, paperNormal] = await Promise.all(
        ['leather-color', 'leather-normal', 'leather-rough', 'paper-color', 'paper-normal'].map(image),
      );
      this.photo = { leatherColor, leatherNormal, leatherRough, paperColor, paperNormal };
      setPaperPhoto(paperColor);
    } catch (err) {
      console.warn('Photo textures unavailable, using drawn textures', err);
      this.photo = null;
    }
    // light and reflections photographed inside a real church
    try {
      const hdr = await new HDRLoader().setDataType(THREE.FloatType).loadAsync('/textures/church.hdr');
      // the photo is lit by cool window daylight; grade it toward candle-warm
      const d = hdr.image.data;
      for (let i = 0; i < d.length; i += 4) {
        const l = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
        d[i] = (l + (d[i] - l) * 0.5) * 1.22;
        d[i + 1] = (l + (d[i + 1] - l) * 0.5) * 1.0;
        d[i + 2] = (l + (d[i + 2] - l) * 0.5) * 0.68;
      }
      hdr.needsUpdate = true;
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.scene.environment = pmrem.fromEquirectangular(hdr).texture;
      this.scene.environmentRotation.y = 1.9;
      pmrem.dispose();
      hdr.dispose();
    } catch (err) {
      console.warn('Environment light unavailable, using the built-in room', err);
    }
    // the wooden table the Bible rests on
    try {
      const [color, normal, rough] = await Promise.all(['wood-color', 'wood-normal', 'wood-rough'].map(image));
      const m = this.floorMat;
      m.map = this.photoTex(color, 13, 13, true);
      m.normalMap = this.photoTex(normal, 13, 13);
      m.normalScale = new THREE.Vector2(0.7, 0.7);
      m.roughnessMap = this.photoTex(rough, 13, 13);
      m.envMapIntensity = 0.18; // satin finish: no mirror-like sheen from the window light
      m.needsUpdate = true;
      this.hasWood = true;
      this.floorDark.set(0x8a6f5c);
      this.floorLight.set(0xc9a585);
    } catch (err) {
      console.warn('Wood texture unavailable, using a plain surface', err);
    }
    this.buildBook();
    this.buildDust();
    await this.drawTextures(lang);
    this.calibrate();
  }

  // Quality levels, best first. The right one is picked by timing real frames
  // on this device, so weaker graphics chips still get a smooth journey.
  setTier(tier) {
    const dpr = window.devicePixelRatio || 1;
    const tiers = this.mobile
      ? [{ pr: 1.25, samples: 0, taps: 10 }, { pr: 1.0, samples: 0, taps: 0 }, { pr: 0.75, samples: 0, taps: 0 }]
      : [{ pr: 1.5, samples: 4, taps: 22 }, { pr: 1.0, samples: 2, taps: 12 }, { pr: 1.0, samples: 0, taps: 0 }, { pr: 0.8, samples: 0, taps: 0 }];
    this.tierCount = tiers.length;
    this.tier = Math.min(tier, tiers.length - 1);
    const q = tiers[this.tier];
    const pixelRatio = Math.min(dpr, q.pr);
    this.renderer.setPixelRatio(pixelRatio);
    this.film.setQuality({ pixelRatio, samples: q.samples, taps: q.taps });
    this.resize();
  }

  calibrate() {
    const forced = new URLSearchParams(location.search).get('q');
    if (forced !== null) { this.setTier(parseInt(forced, 10) || 0); return; }
    const gl = this.renderer.getContext();
    const px = new Uint8Array(4);
    const frame = () => { this.shadowKey = ''; this.update(0.3, 0, 0, true); };
    const measure = () => {
      frame();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const t0 = performance.now();
      for (let i = 0; i < 4; i++) frame();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return (performance.now() - t0) / 4;
    };
    this.setTier(0);
    while (this.tier < this.tierCount - 1 && measure() > 26) this.setTier(this.tier + 1);
    this.shadowKey = '';
  }

  photoTex(img, rx, ry, srgb = false) {
    const t = new THREE.Texture(img);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rx, ry);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = this.maxAniso;
    t.needsUpdate = true;
    return t;
  }

  tex(canvas, repeat) {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = this.maxAniso;
    if (repeat) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repeat[0], repeat[1]);
    }
    return t;
  }

  buildBook() {
    const leatherCanvas = leatherColorCanvas();
    this.leatherCanvas = leatherCanvas;
    const bumpCanvas = leatherBumpCanvas();
    const bump = (rx, ry) => {
      const t = this.tex(bumpCanvas, [rx, ry]);
      t.colorSpace = THREE.NoColorSpace;
      return t;
    };

    const P = this.photo;
    const LEATHER_TILES = [1.6, 2.3];   // how many times the leather scan repeats across a cover
    const leatherPhoto = (rx, ry, tint) => new THREE.MeshStandardMaterial({
      map: this.photoTex(P.leatherColor, rx, ry, true),
      normalMap: this.photoTex(P.leatherNormal, rx, ry),
      normalScale: new THREE.Vector2(1.25, 1.25),
      roughnessMap: this.photoTex(P.leatherRough, rx, ry),
      roughness: 1, metalness: 0, color: tint, envMapIntensity: 0.55,
    });
    const leather = P ? leatherPhoto(LEATHER_TILES[0], LEATHER_TILES[1], 0xa3927f) : new THREE.MeshStandardMaterial({
      map: this.tex(leatherCanvas, [3, 4.4]), bumpMap: bump(5, 7.3), bumpScale: 3.2, roughness: 0.58, metalness: 0,
    });
    const spineLeather = P ? leatherPhoto(0.34, LEATHER_TILES[1], 0xa3927f) : new THREE.MeshStandardMaterial({
      map: this.tex(leatherCanvas, [1, 4.4]), bumpMap: bump(1.3, 7.3), bumpScale: 3.2, roughness: 0.58,
    });
    const endpaper = P ? leatherPhoto(2.1, 3, 0xcdbba6)
      : new THREE.MeshStandardMaterial({ color: 0x4a3120, bumpMap: bump(7, 10), bumpScale: 1.4, roughness: 0.72 });
    this.leatherTiles = LEATHER_TILES;

    // front cover with the gold-stamped title
    const cw = this.mobile ? 768 : 1024;
    this.coverCanvas = makeCanvas(cw, Math.round(cw * (CH / (CW + CT))));
    this.ormCanvas = makeCanvas(this.coverCanvas.width, this.coverCanvas.height);
    this.coverTex = this.tex(this.coverCanvas);
    this.ormTex = this.tex(this.ormCanvas);
    this.ormTex.colorSpace = THREE.NoColorSpace;
    const titled = new THREE.MeshStandardMaterial({
      map: this.coverTex,
      roughnessMap: this.ormTex, metalnessMap: this.ormTex, roughness: 1, metalness: 1,
    });
    if (P) {
      titled.normalMap = this.photoTex(P.leatherNormal, LEATHER_TILES[0], LEATHER_TILES[1]);
      titled.normalScale = new THREE.Vector2(1.25, 1.25);
    } else {
      titled.bumpMap = bump(5, 7.3);
      titled.bumpScale = 3.2;
    }

    // gilt page edges
    const edgeTex = this.tex(edgeCanvas(), [1, 1]);
    const edgeBump = this.tex(edgeCanvas(), [1, 1]);
    edgeBump.colorSpace = THREE.NoColorSpace;
    const gilt = new THREE.MeshStandardMaterial({
      map: edgeTex, bumpMap: edgeBump, bumpScale: 0.5, color: 0xeab76a, roughness: 0.42, metalness: 0.7, envMapIntensity: 0.6, side: THREE.DoubleSide,
    });

    // page textures: [left stack face, leaf fronts/backs..., right stack face]
    const pw = this.mobile ? 768 : 1024;
    const ph = Math.round(pw * PH / PW);
    const pageMat = (side) => {
      const canvas = makeCanvas(pw, ph);
      const map = this.tex(canvas);
      const mat = new THREE.MeshStandardMaterial({ map, roughness: 0.93, metalness: 0, side });
      if (P) {
        // paper fibre relief, taken from the clean part of the scan
        const n = this.photoTex(P.paperNormal, 0.56, 1);
        n.wrapS = n.wrapT = THREE.ClampToEdgeWrapping;
        mat.normalMap = n;
        mat.normalScale = new THREE.Vector2(0.4, 0.4);
      }
      mat.userData.canvas = canvas;
      return mat;
    };
    this.leftPages = [];   // left page of spread k
    this.rightPages = [];  // right page of spread k
    for (let k = 0; k <= N_LEAVES; k++) {
      this.leftPages.push(pageMat(k === 0 ? THREE.FrontSide : THREE.BackSide));
      this.rightPages.push(pageMat(THREE.FrontSide));
    }
    // the first left page sits on the stack that swings over with the cover,
    // so its texture is turned half a revolution; leaf backs are mirrored
    const first = this.leftPages[0].map;
    first.center.set(0.5, 0.5);
    first.rotation = Math.PI;
    for (let k = 1; k <= N_LEAVES; k++) {
      const m = this.leftPages[k].map;
      m.wrapS = THREE.RepeatWrapping;
      m.repeat.x = -1;
      m.offset.x = 1;
    }

    // assembly
    this.root = new THREE.Group();   // position / yaw of the whole book
    this.book = new THREE.Group();   // keeps the book centred as it opens
    this.root.add(this.book);
    this.scene.add(this.root);

    const shadowed = (mesh) => { mesh.castShadow = true; mesh.receiveShadow = true; return mesh; };

    const back = shadowed(new THREE.Mesh(coverSlab(-CT, CW, -CT, 0), [leather, leather, endpaper, leather, leather, leather]));
    this.book.add(back);

    this.rightStack = new PageStack(TR, this.rightPages[N_LEAVES], gilt);
    this.book.add(this.rightStack.group);

    this.ribbon = new Ribbon();
    this.book.add(this.ribbon.mesh);

    // warm light that seems to rise from the pages as the book opens
    this.glow = new THREE.PointLight(0xffc27a, 0, 3.5, 2);
    this.glow.position.set(0, 0.34, 0);
    this.book.add(this.glow);

    this.leaves = [];
    for (let i = 0; i < N_LEAVES; i++) {
      const leaf = new Leaf(i, this.rightPages[i], this.leftPages[i + 1]);
      this.leaves.push(leaf);
      this.book.add(leaf.group);
    }

    this.spinePivot = new THREE.Group();
    const spineGeo = new THREE.BoxGeometry(S, CT - 0.003, CH);
    spineGeo.translate(S / 2, CT / 2, 0);
    this.spinePivot.add(shadowed(new THREE.Mesh(spineGeo, spineLeather)));
    this.book.add(this.spinePivot);

    this.coverPivot = new THREE.Group();
    this.coverPivot.position.x = S;
    this.spinePivot.add(this.coverPivot);
    this.frontGeo = coverSlab(-CT, CW, 0, CT);
    this.coverPivot.add(shadowed(new THREE.Mesh(this.frontGeo, [leather, leather, titled, endpaper, leather, leather])));

    this.leftStack = new PageStack(TL, this.leftPages[0], gilt);
    this.leftStack.group.rotation.x = Math.PI;
    this.coverPivot.add(this.leftStack.group);
  }

  buildDust() {
    const count = this.mobile ? 50 : 130;
    const pos = new Float32Array(count * 3);
    this.dustSeed = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      this.dustSeed[i * 3] = (Math.random() - 0.5) * 7;
      this.dustSeed[i * 3 + 1] = Math.random() * 4;
      this.dustSeed[i * 3 + 2] = (Math.random() - 0.5) * 5;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const c = makeCanvas(64, 64), ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,226,170,1)');
    g.addColorStop(1, 'rgba(255,226,170,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    this.dustMat = new THREE.PointsMaterial({
      map: new THREE.CanvasTexture(c), size: 0.035, transparent: true, opacity: 0.5, depthWrite: false, sizeAttenuation: true,
    });
    this.dust = new THREE.Points(geo, this.dustMat);
    this.dust.frustumCulled = false;
    this.scene.add(this.dust);
  }

  async drawTextures(lang = this.lang) {
    this.lang = lang;
    if (!this.leftPages) return; // book not built yet; init() draws with this.lang
    await loadPageFonts();
    drawCover(this.coverCanvas, this.ormCanvas, lang, this.leatherCanvas, this.photo && { image: this.photo.leatherColor, tiles: this.leatherTiles, tint: 'rgb(163,146,127)' });
    this.coverTex.needsUpdate = true;
    this.ormTex.needsUpdate = true;
    scripture.forEach((passage, k) => {
      drawDisplayPage(this.leftPages[k].userData.canvas, passage, lang);
      drawContextPage(this.rightPages[k].userData.canvas, passage, lang);
      this.leftPages[k].map.needsUpdate = true;
      this.rightPages[k].map.needsUpdate = true;
    });
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.film.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // P: scroll progress 0..1. intro: 1 → 0 once on load (the Bible descending
  // into view). time: seconds, used only for the drifting dust.
  update(P, intro, time, reducedMotion) {
    const o = smoother(range(P, T.openStart, T.openEnd));        // book open amount
    const arrive = smooth(range(P, 0, T.arrivalEnd));
    const bright = smooth(range(P, T.brightStart, T.brightEnd));
    const theta = Math.PI * o;

    // covers
    this.spinePivot.rotation.z = Math.PI / 2 + (Math.PI / 2) * o;
    this.coverPivot.rotation.z = -Math.PI / 2 + (Math.PI / 2) * o;
    const bow = FLEX * Math.sin(2 * theta);
    bowSlab(this.frontGeo, -bow);
    this.leftStack.update(o, bow);
    this.rightStack.update(o, 0);
    for (let i = 0; i < N_LEAVES; i++) this.leaves[i].update(turnProgress(P, i), o);

    // keep the book centred, turned slightly while closed
    this.book.position.x = lerp(-PW / 2, S / 2, o);
    this.root.rotation.y = lerp(-0.34, 0, o);
    const drop = smoother(intro);
    this.root.position.y = drop * 3.4 + lerp(0.42, 0, arrive) * (1 - o);
    this.root.rotation.x = drop * -0.5 + lerp(0.1, 0, arrive);
    this.root.rotation.z = drop * 0.25 + lerp(-0.035, 0, arrive);

    this.ribbon.update(this.rightStack.ribbonX, this.rightStack.ribbonY, -CT - this.root.position.y, this.rightStack.ribbonTilt);

    // camera: glide along the shot path, with a faint hand-held breath
    this.path.at(P, _pos, _tgt);
    const aspect = this.camera.aspect;
    // step back on narrow or short windows so the captions have room
    const short = Math.min(1.4, Math.max(1, 760 / window.innerHeight));
    const fit = lerp(Math.max(1, 0.78 / aspect), Math.max(1, 1.3 / aspect) * short, o);
    _pos.sub(_tgt).multiplyScalar(fit).add(_tgt);
    const tt = reducedMotion ? 0 : time;
    _pos.x += Math.sin(tt * 0.5) * 0.012;
    _pos.y += Math.sin(tt * 0.37 + 1) * 0.008;
    _tgt.x += Math.sin(tt * 0.43 + 2) * 0.006;
    _tgt.y += Math.cos(tt * 0.31) * 0.004;
    this.camera.position.copy(_pos);
    this.camera.lookAt(_tgt);

    // light: one stage light in the dark, then morning
    const reveal = 1 - drop * 0.85;
    this.key.intensity = (lerp(1.25, 1.15, arrive) + bright * 0.1) * reveal;
    this.rim.intensity = lerp(3.2, 1, bright) * reveal;
    this.sun.intensity = bright * 1.7;
    this.fill.intensity = bright * 0.3;
    this.glow.position.x = (-S / 2) * o;
    this.glow.intensity = (1.1 * Math.sin(Math.PI * range(P, T.openStart, T.openEnd + 0.04)) + 0.12 * o) * (1 - bright);
    this.scene.environmentIntensity = (lerp(0.3, 0.42, arrive) + bright * 0.15) * reveal;
    this.scene.background.lerpColors(this.bgDark, this.bgLight, bright);
    this.scene.fog.color.copy(this.scene.background);
    this.floorMat.color.lerpColors(this.floorDark, this.floorLight, bright);
    this.floorMat.roughness = this.hasWood ? 1 : lerp(0.42, 0.9, bright);
    const lift = this.root.position.y;
    this.contact.scale.set(lerp(1.75, 3.1, o), 2.25, 1);
    this.contact.rotation.z = this.root.rotation.y;
    this.contactMat.opacity = 0.6 * Math.max(0, 1 - lift / 0.6) * reveal;
    this.beamMat.uniforms.uOpacity.value = lerp(0.06, 0.12, arrive) * (1 - bright) * reveal;

    // dust motes (ambient only, never part of the Bible's motion)
    const dp = this.dust.geometry.attributes.position.array;
    for (let i = 0; i < dp.length; i += 3) {
      const sx = this.dustSeed[i], sy = this.dustSeed[i + 1], sz = this.dustSeed[i + 2];
      dp[i] = sx + Math.sin(tt * 0.11 + sy * 4) * 0.25;
      dp[i + 1] = ((sy + tt * 0.035 * (0.5 + Math.abs(sx) * 0.2)) % 4) - 0.2;
      dp[i + 2] = sz + Math.cos(tt * 0.09 + sx * 3) * 0.25;
    }
    this.dust.geometry.attributes.position.needsUpdate = true;
    this.dustMat.opacity = 0.55 * (1 - bright) * clamp01(1 - drop);

    const shadowKey = P.toFixed(4) + '|' + intro.toFixed(3);
    if (shadowKey !== this.shadowKey) {
      this.shadowKey = shadowKey;
      this.renderer.shadowMap.needsUpdate = true;
    }

    // lens: shallow focus up close, deeper once the pages are being read
    const shallow = 1 - smooth(range(P, 0.04, 0.27));
    const focus = _pos.distanceTo(_tgt);
    this.film.render({
      focus,
      range: focus * lerp(0.34, 0.32, shallow),
      blur: lerp(3, 5, shallow),
      bloom: lerp(0.22, 0.04, bright),
      vignette: lerp(0.85, 0.12, bright),
      grain: lerp(0.05, 0.03, bright),
      time: reducedMotion ? 0 : Math.floor(time * 24) / 24,
    });
  }
}
