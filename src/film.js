// Plays the pre-rendered Bible film (film/bible_film.py) under scroll control.
// Frame f of N matches scroll progress P = f / (N - 1), so scrolling forward
// and backward moves through the film like a scrub bar. Neighbouring frames
// are blended for in-between positions, so even slow scrolling stays smooth.

export const FILM = { frames: 300, width: 1920, height: 1080 };

const pad = (n) => String(n).padStart(4, '0');

// Load coarse frames first so the whole journey is scrubbable quickly,
// then fill in the gaps.
function loadOrder(n) {
  const order = [];
  const seen = new Set();
  for (const stride of [32, 16, 8, 4, 2, 1]) {
    for (let i = 0; i < n; i += stride) {
      if (!seen.has(i)) { seen.add(i); order.push(i); }
    }
  }
  if (!seen.has(n - 1)) order.push(n - 1);
  return order;
}

export class FilmPlayer {
  constructor(canvas, { frames, width, height } = FILM) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.n = frames;
    this.w = width;
    this.h = height;
    this.sets = {};
    this.drawn = '';
    this.resize();
  }

  url(lang, i) { return `/film/${lang}/frame_${pad(i)}.webp`; }

  loadFrame(set, i) {
    if (set.images[i] || set.pending.has(i)) return Promise.resolve(set.images[i]);
    set.pending.add(i);
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        // Pre-decoding keeps scrubbing smooth, but browsers can leave decode()
        // pending while a tab is in the background, so never wait on it long.
        const decoded = img.decode ? img.decode().catch(() => {}) : Promise.resolve();
        Promise.race([decoded, new Promise((r) => setTimeout(r, 400))]).then(() => {
          set.images[i] = img;
          set.pending.delete(i);
          this.drawn = '';
          resolve(img);
        });
      };
      img.onerror = () => { set.pending.delete(i); reject(new Error(`frame ${i} failed`)); };
      img.src = this.url(set.lang, i);
    });
  }

  async stream(set) {
    const order = loadOrder(this.n);
    let next = 0;
    const worker = async () => {
      while (next < order.length && set === this.sets[set.lang]) {
        const i = order[next++];
        try { await this.loadFrame(set, i); } catch { /* skip a missing frame */ }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
  }

  async use(lang) {
    let set = this.sets[lang];
    if (!set) {
      set = this.sets[lang] = { lang, images: new Array(this.n), pending: new Set() };
      await this.loadFrame(set, 0);   // fails fast if this film was never rendered
      this.stream(set);
    }
    this.set = set;
    this.drawn = '';
  }

  // The film is only used once every frame of both languages has been
  // rendered (the renderer writes complete.json last). Until then the site
  // keeps the live 3D Bible, so the opening and page turns always play.
  async init(lang) {
    const manifests = await Promise.all(['es', 'en'].map((l) =>
      fetch(`/film/${l}/complete.json`, { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)));
    if (!manifests.every((m) => m && m.frames === this.n)) throw new Error('film not fully rendered yet');
    await this.use(lang);
  }

  // The site calls this when the visitor switches language.
  setLanguage(lang) { return this.use(lang).catch(() => {}); }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cw = Math.round(window.innerWidth * dpr);
    this.ch = Math.round(window.innerHeight * dpr);
    this.canvas.width = this.cw;
    this.canvas.height = this.ch;
    // Fill the screen on wide windows; on tall phones keep most of the
    // width of the shot instead of cropping the open Bible away.
    const cover = Math.max(this.cw / this.w, this.ch / this.h);
    const contain = Math.min(this.cw / this.w, this.ch / this.h);
    this.scale = this.cw >= this.ch ? cover : Math.max(contain, Math.min(cover, (this.cw / this.w) * 1.5));
    this.drawn = '';
  }

  nearest(i) {
    const imgs = this.set.images;
    for (let d = 0; d < this.n; d++) {
      if (imgs[i - d]) return imgs[i - d];
      if (imgs[i + d]) return imgs[i + d];
    }
    return null;
  }

  update(P) {
    if (!this.set) return;
    const f = Math.min(1, Math.max(0, P)) * (this.n - 1);
    const i0 = Math.floor(f);
    const i1 = Math.min(this.n - 1, i0 + 1);
    const w = f - i0;
    const a = this.nearest(i0);
    if (!a) return;
    const b = this.set.images[i1];
    const key = `${this.set.lang}|${f.toFixed(3)}|${a.src}|${b ? 1 : 0}`;
    if (key === this.drawn) return;
    this.drawn = key;

    const ctx = this.ctx;
    const dw = this.w * this.scale, dh = this.h * this.scale;
    const x = (this.cw - dw) / 2, y = (this.ch - dh) / 2;
    ctx.globalAlpha = 1;
    ctx.drawImage(a, x, y, dw, dh);
    if (b && b !== a && w > 0.02) {
      ctx.globalAlpha = w;
      ctx.drawImage(b, x, y, dw, dh);
      ctx.globalAlpha = 1;
    }
    if (y > 1) this.fillBands(b && w > 0.5 ? b : a, y, dh);
  }

  // The average colour of the shot's top and bottom edge, measured once per
  // frame on a tiny canvas and kept with the image.
  tones(img) {
    if (img._tones) return img._tones;
    if (!this.probe) {
      this.probe = document.createElement('canvas');
      this.probe.width = 1; this.probe.height = 2;
    }
    const p = this.probe.getContext('2d', { willReadFrequently: true });
    const sw = this.cw / this.scale, sx = (this.w - sw) / 2, edge = this.h * 0.05;
    p.imageSmoothingQuality = 'high';
    p.drawImage(img, sx, 0, sw, edge, 0, 0, 1, 1);
    p.drawImage(img, sx, this.h - edge, sw, edge, 0, 1, 1, 1);
    const d = p.getImageData(0, 0, 1, 2).data;
    img._tones = [[d[0], d[1], d[2]], [d[4], d[5], d[6]]];
    return img._tones;
  }

  // Tall phone screens show the whole width of the shot with room above and
  // below it. That room becomes a soft haze in the shot's own sky and cloud
  // colours, and the shot dissolves into it, instead of black bars.
  fillBands(img, y, dh) {
    const ctx = this.ctx;
    const [top, bot] = this.tones(img);
    const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
    const IVORY = [250, 244, 235];
    const lift = (c, k) => c.map((v, i) => v + (IVORY[i] - v) * k);   // toward the warm light
    const fade = Math.min(y, dh * 0.16);
    const bands = [
      { c: top, from: 0, seam: y, inward: 1, k: 0.45 },
      { c: bot, from: this.ch, seam: y + dh, inward: -1, k: 0.6 },
    ];
    for (const { c, from, seam, inward, k } of bands) {
      const g = ctx.createLinearGradient(0, from, 0, seam + inward * fade);
      const t = Math.abs(seam - from) / Math.abs(seam + inward * fade - from);
      g.addColorStop(0, rgb(lift(c, k)));
      g.addColorStop(t * 0.999, rgb(c));
      g.addColorStop(1, rgb(c, 0));
      ctx.fillStyle = g;
      if (inward > 0) ctx.fillRect(0, 0, this.cw, seam + fade);
      else ctx.fillRect(0, seam - fade, this.cw, this.ch - seam + fade);
    }
  }
}
