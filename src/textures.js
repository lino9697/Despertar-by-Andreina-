// Canvas-drawn textures: leather, gilt page edges, the cover, and the Bible pages.
// Page text comes only from src/data/scripture.json (KJV / Reina-Valera 1909, verbatim).

const SERIF = '"EB Garamond", Georgia, serif';
const DISPLAY = '"Cormorant Garamond", "EB Garamond", Georgia, serif';

const INK = '#2b2118';
const INK_SOFT = '#6f5a43';
const GOLD_INK = '#8b6a2e';
const PAPER = '#f4ecd9';

export const TRANSLATION = { en: 'King James Version', es: 'Reina-Valera 1909' };
export const COVER_TITLE = { en: ['HOLY', 'BIBLE'], es: ['SANTA', 'BIBLIA'] };

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// Deterministic random so textures look the same on every load.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export async function loadPageFonts() {
  if (!document.fonts) return;
  const sample = 'AaÁáÑñ¿¡0123';
  await Promise.all(
    [
      `400 30px ${SERIF}`,
      `italic 400 30px ${SERIF}`,
      `500 30px ${SERIF}`,
      `500 30px ${DISPLAY}`,
      `600 30px ${DISPLAY}`,
    ].map((f) => document.fonts.load(f, sample).catch(() => {})),
  );
}

/* ---------- leather ---------- */

export function leatherColorCanvas(size = 512) {
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#2a1a10';
  ctx.fillRect(0, 0, size, size);
  const r = rng(11);
  for (let i = 0; i < 2600; i++) {
    const x = r() * size, y = r() * size, rad = 2 + r() * 9;
    ctx.fillStyle = r() > 0.5 ? 'rgba(92,58,32,0.05)' : 'rgba(8,4,2,0.07)';
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}

export function leatherBumpCanvas(size = 512) {
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#6a6a6a';
  ctx.fillRect(0, 0, size, size);
  const r = rng(29);
  // Pebbled grain: soft raised bumps separated by darker creases.
  for (let i = 0; i < 5200; i++) {
    const x = r() * size, y = r() * size, rad = 2.5 + r() * 4.5;
    for (const [ox, oy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size]]) {
      const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, rad);
      g.addColorStop(0, 'rgba(215,215,215,0.55)');
      g.addColorStop(0.7, 'rgba(150,150,150,0.18)');
      g.addColorStop(1, 'rgba(40,40,40,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x + ox, y + oy, rad, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return c;
}

/* ---------- gilt page edges ---------- */

export function edgeCanvas() {
  const c = makeCanvas(8, 512);
  const ctx = c.getContext('2d');
  const r = rng(5);
  for (let y = 0; y < 512; y++) {
    const v = 0.72 + r() * 0.28;
    ctx.fillStyle = `rgb(${Math.round(226 * v)},${Math.round(188 * v)},${Math.round(112 * v)})`;
    ctx.fillRect(0, y, 8, 1);
  }
  return c;
}

/* ---------- front cover ---------- */

function coverArt(ctx, w, h, lang, colors) {
  const m = w * 0.075;
  ctx.strokeStyle = colors.gold;
  ctx.fillStyle = colors.gold;
  ctx.lineWidth = w * 0.006;
  ctx.strokeRect(m, m, w - m * 2, h - m * 2);
  ctx.lineWidth = w * 0.002;
  ctx.strokeRect(m + w * 0.018, m + w * 0.018, w - (m + w * 0.018) * 2, h - (m + w * 0.018) * 2);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const [l1, l2] = COVER_TITLE[lang];
  const size = w * 0.118;
  ctx.font = `600 ${size}px ${DISPLAY}`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${size * 0.16}px`;
  const cx = w / 2 + size * 0.08;
  ctx.fillText(l1, cx, h * 0.36);
  ctx.fillText(l2, cx, h * 0.36 + size * 1.15);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';

  // small ornament: a rule with a diamond
  const oy = h * 0.36 + size * 1.75;
  ctx.lineWidth = w * 0.0025;
  ctx.beginPath();
  ctx.moveTo(w / 2 - w * 0.13, oy);
  ctx.lineTo(w / 2 - w * 0.025, oy);
  ctx.moveTo(w / 2 + w * 0.025, oy);
  ctx.lineTo(w / 2 + w * 0.13, oy);
  ctx.stroke();
  ctx.save();
  ctx.translate(w / 2, oy);
  ctx.rotate(Math.PI / 4);
  ctx.fillRect(-w * 0.009, -w * 0.009, w * 0.018, w * 0.018);
  ctx.restore();
}

export function drawCover(colorCanvas, ormCanvas, lang, leather, photo) {
  const w = colorCanvas.width, h = colorCanvas.height;
  let ctx = colorCanvas.getContext('2d');
  if (photo) {
    // tile the leather scan exactly as the rest of the cover does, then deepen it
    const tw = w / photo.tiles[0], th = h / photo.tiles[1];
    for (let y = h - th; y > -th; y -= th) for (let x = 0; x < w; x += tw) ctx.drawImage(photo.image, x, y, tw + 1, th + 1);
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = photo.tint;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
  } else {
    ctx.fillStyle = ctx.createPattern(leather, 'repeat');
    ctx.fillRect(0, 0, w, h);
  }
  // slightly darker toward the edges, like worn leather
  const g = ctx.createRadialGradient(w / 2, h / 2, h * 0.2, w / 2, h / 2, h * 0.75);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.38)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  coverArt(ctx, w, h, lang, { gold: '#d9b871' });

  // roughness in G, metalness in B
  ctx = ormCanvas.getContext('2d');
  ctx.fillStyle = 'rgb(0,165,0)';
  ctx.fillRect(0, 0, w, h);
  coverArt(ctx, w, h, lang, { gold: 'rgb(0,70,255)' });
}

/* ---------- pages ---------- */

let paperPhoto = null;
export function setPaperPhoto(image) { paperPhoto = image; }

function paper(ctx, w, h, gutterOnLeft, seed) {
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, w, h);
  if (paperPhoto) {
    // real paper fibre from the scan (its clean left part), laid over the page colour
    ctx.globalCompositeOperation = 'multiply';
    const side = Math.min(600, paperPhoto.height);
    ctx.drawImage(paperPhoto, 0, 0, side, side, 0, 0, w, w);
    ctx.save();
    ctx.translate(0, 2 * w);
    ctx.scale(1, -1);
    ctx.drawImage(paperPhoto, 0, 0, side, side, 0, 0, w, w);
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
  } else {
    const r = rng(seed);
    for (let i = 0; i < 2600; i++) {
      ctx.fillStyle = r() > 0.5 ? 'rgba(120,96,60,0.035)' : 'rgba(255,255,255,0.06)';
      ctx.fillRect(r() * w, r() * h, 2, 2);
    }
  }
  // shadow falling into the gutter
  const gw = w * 0.2;
  const g = gutterOnLeft ? ctx.createLinearGradient(0, 0, gw, 0) : ctx.createLinearGradient(w, 0, w - gw, 0);
  g.addColorStop(0, 'rgba(58,40,22,0.42)');
  g.addColorStop(0.35, 'rgba(58,40,22,0.12)');
  g.addColorStop(1, 'rgba(58,40,22,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function wrap(ctx, text, maxWidth, firstIndent = 0) {
  const words = text.split(' ');
  const lines = [];
  let line = [];
  let width = firstIndent;
  const space = ctx.measureText(' ').width;
  for (const word of words) {
    const ww = ctx.measureText(word).width;
    if (line.length && width + space + ww > maxWidth) {
      lines.push(line);
      line = [word];
      width = ww;
    } else {
      width += (line.length ? space : 0) + ww;
      line.push(word);
    }
  }
  if (line.length) lines.push(line);
  return lines;
}

function runningHead(ctx, w, s, passage, lang, gutterOnLeft) {
  const y = 96 * s;
  const left = (gutterOnLeft ? 136 : 84) * s;
  const right = w - (gutterOnLeft ? 84 : 136) * s;
  ctx.fillStyle = INK_SOFT;
  ctx.font = `500 ${21 * s}px ${SERIF}`;
  ctx.textBaseline = 'alphabetic';
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${4 * s}px`;
  ctx.textAlign = gutterOnLeft ? 'right' : 'left';
  ctx.fillText(`${passage.book[lang].toUpperCase()} ${passage.chapter}`, gutterOnLeft ? right : left, y);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  ctx.strokeStyle = 'rgba(111,90,67,0.55)';
  ctx.lineWidth = 1.2 * s;
  ctx.beginPath();
  ctx.moveTo(left, y + 16 * s);
  ctx.lineTo(right, y + 16 * s);
  ctx.stroke();
  return { left, right };
}

function refLabel(passage) {
  const v = passage.verses;
  return `${passage.chapter}:${v[0]}${v.length > 1 ? '–' + v[v.length - 1] : ''}`;
}

// Left page of a spread: the featured passage, set large.
export function drawDisplayPage(canvas, passage, lang) {
  const w = canvas.width, h = canvas.height, s = w / 1024;
  const ctx = canvas.getContext('2d');
  paper(ctx, w, h, false, passage.chapter * 7 + 1);
  runningHead(ctx, w, s, passage, lang, false);

  const cx = w / 2 - 10 * s;
  ctx.textAlign = 'center';
  ctx.fillStyle = INK_SOFT;
  ctx.font = `500 ${27 * s}px ${SERIF}`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${9 * s}px`;
  ctx.fillText(passage.book[lang].toUpperCase(), cx + 4 * s, 330 * s);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';

  ctx.fillStyle = GOLD_INK;
  ctx.font = `500 ${150 * s}px ${DISPLAY}`;
  ctx.fillText(refLabel(passage), cx, 480 * s);

  ctx.strokeStyle = GOLD_INK;
  ctx.lineWidth = 1.6 * s;
  ctx.beginPath();
  ctx.moveTo(cx - 70 * s, 540 * s);
  ctx.lineTo(cx + 70 * s, 540 * s);
  ctx.stroke();

  const text = passage.verses.map((n) => passage.text[lang].find((v) => v.n === n).t).join(' ');
  let size = 54;
  let lines;
  const maxW = 730 * s;
  for (;;) {
    ctx.font = `italic 400 ${size * s}px ${SERIF}`;
    lines = wrap(ctx, text, maxW);
    if (lines.length * size * 1.36 <= 700 || size <= 34) break;
    size -= 3;
  }
  ctx.fillStyle = INK;
  let y = 640 * s;
  for (const line of lines) {
    ctx.fillText(line.join(' '), cx, y);
    y += size * 1.36 * s;
  }

  ctx.fillStyle = INK_SOFT;
  ctx.font = `500 ${19 * s}px ${SERIF}`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${5 * s}px`;
  ctx.fillText(TRANSLATION[lang].toUpperCase(), cx + 2 * s, h - 92 * s);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
}

// Right page of a spread: the surrounding verses of the chapter, with the
// featured passage marked the way someone would highlight their own Bible.
export function drawContextPage(canvas, passage, lang) {
  const w = canvas.width, h = canvas.height, s = w / 1024;
  const ctx = canvas.getContext('2d');
  paper(ctx, w, h, true, passage.chapter * 13 + 5);
  const { left, right } = runningHead(ctx, w, s, passage, lang, true);

  const size = 34 * s, lh = 46 * s, numSize = 21 * s;
  const maxW = right - left;
  const bottom = h - 96 * s;
  const verses = passage.text[lang];
  const first = passage.verses[0];
  let n = Math.max(1, first - 5);
  let y = 178 * s;
  ctx.textAlign = 'left';

  for (; n <= verses.length; n++) {
    const verse = verses.find((v) => v.n === n);
    if (!verse) break;
    ctx.font = `500 ${numSize}px ${SERIF}`;
    const indent = ctx.measureText(String(n)).width + 9 * s;
    ctx.font = `400 ${size}px ${SERIF}`;
    const lines = wrap(ctx, verse.t, maxW, indent);
    if (y + lines.length * lh > bottom) break;
    const featured = passage.verses.includes(n);
    const space = ctx.measureText(' ').width;

    lines.forEach((words, i) => {
      const x0 = left + (i === 0 ? indent : 0);
      const natural = words.reduce((a, wd) => a + ctx.measureText(wd).width, 0) + space * (words.length - 1);
      const avail = maxW - (i === 0 ? indent : 0);
      const last = i === lines.length - 1;
      const gap = !last && words.length > 1 ? space + (avail - natural) / (words.length - 1) : space;
      const drawnWidth = last ? natural : avail;
      const base = y + i * lh;
      if (featured) {
        ctx.fillStyle = 'rgba(222,176,72,0.36)';
        const hx = i === 0 ? left - 5 * s : x0 - 5 * s;
        const hw = (i === 0 ? indent : 0) + drawnWidth + 10 * s;
        ctx.fillRect(hx, base - size * 0.82, hw, size * 1.12);
      }
      if (i === 0) {
        ctx.fillStyle = GOLD_INK;
        ctx.font = `500 ${numSize}px ${SERIF}`;
        ctx.fillText(String(n), left, base - 8 * s);
        ctx.font = `400 ${size}px ${SERIF}`;
      }
      ctx.fillStyle = INK;
      let x = x0;
      for (const wd of words) {
        ctx.fillText(wd, x, base);
        x += ctx.measureText(wd).width + gap;
      }
    });
    y += lines.length * lh + 7 * s;
  }
}

export { makeCanvas };
