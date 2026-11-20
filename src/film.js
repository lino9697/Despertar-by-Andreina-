// Plays the pre-rendered Bible film (film/bible_film.py) under scroll control.
// Frame f of N matches story progress P = f / (N - 1), so scrolling forward
// and backward moves through the film like a scrub bar. Neighbouring frames
// are blended for in-between positions, so even slow scrolling stays smooth.
//
// Smoothness comes from never decoding a picture while drawing:
//  * every frame is downloaded once and kept compressed (about 18 MB);
//  * only the frames around the current position are decoded, in the
//    background (createImageBitmap), into a small sliding window;
//  * downloads and decodes start where the visitor is and run ahead in the
//    direction they scroll;
//  * small preview frames, always ready, cover a fast flick for the moment
//    it takes the sharp frames to arrive.

export const FILM = { frames: 300, width: 1920, height: 1080 };

const pad = (n) => String(n).padStart(4, '0');
const AHEAD = 18;           // sharp frames kept decoded ahead, in the direction of scrolling
const BEHIND = 8;           // ...and behind
const THUMB_EVERY = 6;      // a preview frame every few frames, always decoded
const THUMB_WIDTH = 480;
const FETCHERS = 4;
const DECODERS = 6;

// Decode a frame off the main thread. Some browsers reject the resize
// options or lack createImageBitmap for blobs; fall back step by step, down
// to a plain image (which the browser decodes itself).
let resizeOk = true;
async function decode(blob, opts) {
  if (typeof createImageBitmap === 'function') {
    if (resizeOk && opts && Object.keys(opts).length) {
      try { return await createImageBitmap(blob, opts); } catch { resizeOk = false; }
    }
    try { return await createImageBitmap(blob); } catch { /* fall through */ }
  }
  const img = new Image();
  img.src = URL.createObjectURL(blob);
  await img.decode().catch(() => new Promise((r) => { img.onload = r; img.onerror = r; }));
  URL.revokeObjectURL(img.src);
  return img;
}
const free = (pic) => { if (pic && pic.close) pic.close(); };

export class FilmPlayer {
  constructor(canvas, { frames, width, height } = FILM) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.n = frames;
    this.w = width;
    this.h = height;
    this.sets = {};
    this.drawn = '';
    this.focus = 0;           // the frame the visitor is at
    this.dir = 1;             // the way they are scrolling
    this.decoding = 0;
    this.resize();
  }

  url(lang, i) { return `/film/${lang}/frame_${pad(i)}.webp`; }

  newSet(lang) {
    return {
      lang,
      blobs: new Array(this.n),
      fetching: new Set(),
      failed: new Set(),
      sharp: new Map(),        // frame -> ImageBitmap at screen size
      queued: new Set(),       // frames being decoded
      thumbs: new Array(this.n),
      tones: new Array(this.n),
    };
  }

  async fetchFrame(set, i) {
    if (set.blobs[i] || set.fetching.has(i)) return;
    set.fetching.add(i);
    try {
      const r = await fetch(this.url(set.lang, i));
      if (!r.ok) throw new Error(`frame ${i}: ${r.status}`);
      set.blobs[i] = await r.blob();
    } finally {
      set.fetching.delete(i);
    }
    if (i % THUMB_EVERY === 0 || i === this.n - 1) this.decodeThumb(set, i);
    this.pump();
  }

  // The next frame to download: the nearest missing one to the visitor,
  // looking further ahead in the direction they are scrolling.
  nextToFetch(set) {
    const f = this.focus;
    for (let d = 0; d < this.n; d++) {
      for (const i of [f + d * this.dir, f - d * this.dir, f + (d + 1) * this.dir]) {
        if (i >= 0 && i < this.n && !set.blobs[i] && !set.fetching.has(i) && !set.failed.has(i)) return i;
      }
    }
    return -1;
  }

  async stream(set) {
    const worker = async () => {
      for (;;) {
        if (set !== this.sets[set.lang]) return;
        const i = this.nextToFetch(set);
        if (i < 0) return;
        try { await this.fetchFrame(set, i); } catch { set.failed.add(i); }
      }
    };
    await Promise.all(Array.from({ length: FETCHERS }, worker));
  }

  decodeSize() {
    // Large screens: decode at full size (quickest). Phones draw the frame
    // much smaller, so decode it at that size to keep memory low.
    if (this.scale > 0.75) return {};
    return { resizeWidth: Math.round(this.w * this.scale), resizeHeight: Math.round(this.h * this.scale), resizeQuality: 'medium' };
  }

  async decodeThumb(set, i) {
    if (set.thumbs[i] || !set.blobs[i]) return;
    try {
      set.thumbs[i] = await decode(set.blobs[i], {
        resizeWidth: THUMB_WIDTH, resizeHeight: Math.round(THUMB_WIDTH * this.h / this.w), resizeQuality: 'medium',
      });
      this.drawn = '';
    } catch { /* the sharp frame will do */ }
  }

  // Keep the sharp frames around the visitor decoded, nearest first, and let
  // go of the ones they have left behind.
  pump() {
    const set = this.set;
    if (!set) return;
    const lo = this.focus - (this.dir > 0 ? BEHIND : AHEAD), hi = this.focus + (this.dir > 0 ? AHEAD : BEHIND);
    for (const [i, bmp] of set.sharp) {
      if (i < lo - 6 || i > hi + 6) { free(bmp); set.sharp.delete(i); }
    }
    for (let d = 0; d <= AHEAD && this.decoding < DECODERS; d++) {
      for (const i of [this.focus + d * this.dir, this.focus - d * this.dir]) {
        if (this.decoding >= DECODERS) break;
        if (i < lo || i > hi) continue;
        if (i < 0 || i >= this.n || set.sharp.has(i) || set.queued.has(i) || !set.blobs[i]) continue;
        set.queued.add(i);
        this.decoding++;
        // Browsers can leave a decode pending (a tab in the background, a
        // busy GPU); never let one hold its slot for long.
        let settled = false;
        const release = () => {
          if (settled) return;
          settled = true;
          set.queued.delete(i);
          this.decoding--;
          this.pump();
        };
        const watchdog = setTimeout(release, 1500);
        decode(set.blobs[i], this.decodeSize())
          .then((bmp) => {
            if (set.sharp.has(i) || !this.sets[set.lang]) free(bmp);
            else { set.sharp.set(i, bmp); if (Math.abs(i - this.focus) <= 1) this.drawn = ''; }
          })
          .catch(() => {})
          .finally(() => { clearTimeout(watchdog); release(); });
      }
    }
  }

  async use(lang) {
    let set = this.sets[lang];
    if (!set) {
      set = this.sets[lang] = this.newSet(lang);
      await this.fetchFrame(set, this.focus);   // fails fast if this film was never rendered
      this.stream(set);
    }
    this.set = set;
    this.drawn = '';
    // show something straight away: the frame the visitor is on
    if (!set.sharp.has(this.focus) && set.blobs[this.focus]) {
      const first = decode(set.blobs[this.focus], this.decodeSize())
        .then((bmp) => { if (!set.sharp.has(this.focus)) set.sharp.set(this.focus, bmp); this.drawn = ''; })
        .catch(() => {});
      // wait briefly for it, but never let a stalled decode hold up the page
      await Promise.race([first, new Promise((r) => setTimeout(r, 800))]);
    }
    this.pump();
  }

  // The film is only used once every frame of both languages has been
  // rendered (the renderer writes complete.json last). Until then the site
  // keeps the live 3D Bible, so the opening and page turns always play.
  async init(lang, P = 0) {
    const manifests = await Promise.all(['es', 'en'].map((l) =>
      fetch(`/film/${l}/complete.json`, { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)));
    if (!manifests.every((m) => m && m.frames === this.n)) throw new Error('film not fully rendered yet');
    this.focus = Math.round(Math.min(1, Math.max(0, P)) * (this.n - 1));
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
    const scale = this.cw >= this.ch ? cover : Math.max(contain, Math.min(cover, (this.cw / this.w) * 1.5));
    if (this.set && Math.abs(scale - this.scale) > 0.05) {
      // re-decode the sharp frames at the new size
      for (const bmp of this.set.sharp.values()) free(bmp);
      this.set.sharp.clear();
    }
    this.scale = scale;
    this.drawn = '';
    this.pump();
  }

  // The best picture available for frame i: its sharp frame, else the
  // nearest sharp one close by, else the nearest preview.
  pick(i) {
    const set = this.set;
    const exact = set.sharp.get(i);
    if (exact) return { img: exact, i, exact: true };
    for (let d = 1; d <= 2; d++) {
      for (const j of [i - d, i + d]) {
        const bmp = set.sharp.get(j);
        if (bmp) return { img: bmp, i: j, exact: false };
      }
    }
    for (let d = 0; d < this.n; d++) {
      for (const j of [i - d, i + d]) {
        if (j >= 0 && j < this.n && set.thumbs[j]) return { img: set.thumbs[j], i: j, exact: false };
      }
    }
    return null;
  }

  update(P) {
    if (!this.set) return;
    const f = Math.min(1, Math.max(0, P)) * (this.n - 1);
    const i0 = Math.floor(f);
    const i1 = Math.min(this.n - 1, i0 + 1);
    const w = f - i0;
    const focus = Math.round(f);
    if (focus !== this.focus) {
      this.dir = focus > this.focus ? 1 : -1;
      this.focus = focus;
      this.pump();
    }
    const a = this.pick(i0);
    if (!a) return;
    // blend toward the next frame only between true neighbours
    const b = a.exact ? this.set.sharp.get(i1) : null;
    const key = `${this.set.lang}|${f.toFixed(3)}|${a.i}|${a.exact ? 1 : 0}|${b ? 1 : 0}`;
    if (key === this.drawn) return;
    this.drawn = key;

    const ctx = this.ctx;
    const dw = this.w * this.scale, dh = this.h * this.scale;
    const x = (this.cw - dw) / 2, y = (this.ch - dh) / 2;
    ctx.globalAlpha = 1;
    ctx.drawImage(a.img, x, y, dw, dh);
    if (b && w > 0.02) {
      ctx.globalAlpha = w;
      ctx.drawImage(b, x, y, dw, dh);
      ctx.globalAlpha = 1;
    }
    if (y > 1) this.fillBands(b && w > 0.5 ? i1 : a.i, b && w > 0.5 ? b : a.img, y, dh);
  }

  // The average colour of the shot's top and bottom edge, measured once per
  // frame on a tiny canvas.
  tones(i, img) {
    const set = this.set;
    if (set.tones[i]) return set.tones[i];
    if (!this.probe) {
      this.probe = document.createElement('canvas');
      this.probe.width = 1; this.probe.height = 2;
    }
    const p = this.probe.getContext('2d', { willReadFrequently: true });
    const iw = img.width, ih = img.height;
    const sw = (this.cw / this.scale) * (iw / this.w), sx = (iw - sw) / 2, edge = ih * 0.05;
    p.imageSmoothingQuality = 'high';
    p.drawImage(img, sx, 0, sw, edge, 0, 0, 1, 1);
    p.drawImage(img, sx, ih - edge, sw, edge, 0, 1, 1, 1);
    const d = p.getImageData(0, 0, 1, 2).data;
    set.tones[i] = [[d[0], d[1], d[2]], [d[4], d[5], d[6]]];
    return set.tones[i];
  }

  // Tall phone screens show the whole width of the shot with room above and
  // below it. That room becomes a soft haze in the shot's own sky and cloud
  // colours, and the shot dissolves into it, instead of black bars.
  fillBands(i, img, y, dh) {
    const ctx = this.ctx;
    const [top, bot] = this.tones(i, img);
    const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
    const IVORY = [250, 244, 235];
    const lift = (c, k) => c.map((v, j) => v + (IVORY[j] - v) * k);   // toward the warm light
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
