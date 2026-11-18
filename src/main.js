import '@fontsource/cormorant-garamond/500.css';
import '@fontsource/cormorant-garamond/600.css';
import '@fontsource/cormorant-garamond/500-italic.css';
import '@fontsource/eb-garamond/400.css';
import '@fontsource/eb-garamond/400-italic.css';
import '@fontsource/eb-garamond/500.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import './style.css';

import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import scripture from './data/scripture.json';
import { STRINGS, REFS, WHATSAPP_NUMBER } from './i18n.js';
import { TRANSLATION } from './textures.js';
import { N_LEAVES, T, clamp01, lerp, smooth, range, spreadWindow } from './timeline.js';
import { FilmPlayer } from './film.js';

gsap.registerPlugin(ScrollTrigger);

const root = document.documentElement;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const mobile = window.matchMedia('(max-width: 760px), (pointer: coarse) and (max-width: 1024px)').matches;

/* ---------- language ---------- */
let lang = 'es';
try {
  const saved = localStorage.getItem('despertar-lang');
  if (saved === 'en' || saved === 'es') lang = saved;
} catch { /* storage unavailable: stay with Spanish */ }

const t = (key) => STRINGS[lang][key] ?? key;
const verseText = (passage) => passage.verses.map((n) => passage.text[lang].find((v) => v.n === n).t).join(' ');

/* ---------- captions for each spread (message above, verse below) ---------- */
const spreads = document.getElementById('spreads');
scripture.forEach((passage, k) => {
  const [a, b] = spreadWindow(k);
  const message = document.createElement('div');
  message.className = 'cap top';
  message.dataset.in = a;
  message.dataset.out = b;
  message.innerHTML = `<p class="message${k === 3 ? ' long' : ''}" data-i18n="spread.${k}"></p>`;

  const verse = document.createElement('figure');
  verse.className = 'cap bottom verse';
  verse.dataset.in = a;
  verse.dataset.out = b;
  verse.style.margin = '0 auto';
  verse.innerHTML = `<blockquote data-verse="${k}"></blockquote><cite><span data-ref="${k}"></span> <small data-translation></small></cite>`;
  spreads.append(message, verse);
});

function applyLanguage() {
  root.lang = lang;
  document.title = t('meta.title');
  document.querySelector('meta[name="description"]').content = t('meta.description');
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    const [attr, key] = el.dataset.i18nAttr.split(':');
    el.setAttribute(attr, t(key));
  });
  document.querySelectorAll('[data-verse]').forEach((el) => {
    el.textContent = `“${verseText(scripture[+el.dataset.verse])}”`;
  });
  document.querySelectorAll('[data-ref]').forEach((el) => { el.textContent = REFS[lang][+el.dataset.ref]; });
  document.querySelectorAll('[data-translation]').forEach((el) => { el.textContent = `· ${TRANSLATION[lang]}`; });
  document.querySelectorAll('.lang button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
}
applyLanguage();

/* ---------- scroll state ---------- */
const state = { P: 0, intro: 0 };
gsap.to(state, {
  P: 1,
  ease: 'none',
  scrollTrigger: { trigger: '#journey', start: 'top top', end: 'bottom bottom', scrub: reducedMotion ? true : 1 },
});

const caps = [...document.querySelectorAll('.cap')].map((el) => ({ el, a: +el.dataset.in, b: +el.dataset.out, shown: -1 }));
const FADE = 0.014;

const DARK = { bg: [11, 8, 6], fg: [242, 231, 211] };
const LIGHT = { bg: [243, 235, 221], fg: [44, 33, 24] };
const mix = (a, b, k) => `rgb(${a.map((v, i) => Math.round(lerp(v, b[i], k))).join(',')})`;
let lastTone = -1;

function updateOverlay(P) {
  for (const c of caps) {
    const alpha = Math.min(c.a < 0 ? 1 : range(P, c.a, c.a + FADE), 1 - range(P, c.b - FADE, c.b));
    const shown = Math.round(alpha * 100) / 100;
    if (shown === c.shown) continue;
    c.shown = shown;
    c.el.style.opacity = shown;
    c.el.style.visibility = shown > 0 ? 'visible' : 'hidden';
    c.el.style.transform = `translateY(${(1 - shown) * 14}px)`;
  }
  // the page turns from dark to ivory only as the film ends and the scene fades
  const bright = Math.round(smooth(range(P, T.fadeStart, 0.97)) * 200) / 200;
  if (bright !== lastTone) {
    lastTone = bright;
    root.style.setProperty('--bg', mix(DARK.bg, LIGHT.bg, bright));
    root.style.setProperty('--fg', mix(DARK.fg, LIGHT.fg, bright));
  }
  const fade = smooth(range(P, T.fadeStart, 1));
  root.style.setProperty('--scene-opacity', (1 - 0.74 * fade).toFixed(3));
  root.style.setProperty('--scene-filter', fade > 0.01 ? `blur(${(fade * 3).toFixed(2)}px)` : 'none');
  const bars = smooth(range(P, 0.01, 0.06)) * (1 - smooth(range(P, T.fadeStart, 0.97)));
  root.style.setProperty('--bars', bars.toFixed(3));
  root.style.setProperty('--header-fg', bars > 0.5 ? 'rgb(242,231,211)' : 'var(--fg)');
  root.style.setProperty('--p', P.toFixed(4));
  root.style.setProperty('--rail', (1 - fade).toFixed(3));
  root.style.setProperty('--wordmark', clamp01((P - 0.07) / 0.03).toFixed(3));
}

/* ---------- 3D scene ---------- */
let canvas = document.getElementById('scene');
let scene = null;   // the film player, or the live 3D Bible as a fallback
let live = false;

// The movie-quality film is the main experience. If its frames cannot be
// loaded (or ?mode=live is set), the live real-time 3D Bible takes over.
async function createScene() {
  if (new URLSearchParams(location.search).get('mode') !== 'live') {
    try {
      const film = new FilmPlayer(canvas);
      await film.init(lang);
      return film;
    } catch (err) {
      console.warn('Film unavailable, using the live 3D Bible', err);
    }
  }
  try {
    const fresh = canvas.cloneNode(false);
    canvas.replaceWith(fresh);
    canvas = fresh;
    const { BibleScene } = await import('./bible.js');
    const s = new BibleScene(canvas, { mobile, lang });
    await s.init(lang);
    s.setLanguage = (l) => s.drawTextures(l);
    live = true;
    return s;
  } catch (err) {
    console.warn('3D scene unavailable', err);
    root.classList.add('no-webgl');
    return null;
  }
}

let visible = !document.hidden;
document.addEventListener('visibilitychange', () => { visible = !document.hidden; });
window.addEventListener('resize', () => scene?.resize());

// For checking a single moment while developing: /?p=0.42 holds the journey there.
const held = new URLSearchParams(location.search).get('p');
const heldP = held === null ? null : clamp01(parseFloat(held) || 0);
if (heldP !== null) window.__scene = () => scene;

function frame(now) {
  requestAnimationFrame(frame);
  if (!visible) return;
  const P = heldP ?? state.P;
  updateOverlay(P);
  scene?.update(P, state.intro, now / 1000, reducedMotion);
}

async function start() {
  scene = await createScene();
  if (scene && (!live || scene.sky)) {
    // The film is set in a bright sky: captions turn dark on an ivory glow.
    DARK.bg = [243, 235, 221];
    DARK.fg = [44, 33, 24];
    lastTone = -1;
    root.classList.add('film-mode');
  }
  if (live && false) {
    if (!reducedMotion && heldP === null && window.scrollY < 40) {
      state.intro = 1;
      gsap.to(state, { intro: 0, duration: 3, ease: 'power2.out', delay: 0.2 });
    }
  }
  root.classList.add('ready');
  requestAnimationFrame(frame);
}
start();

document.querySelectorAll('.lang button').forEach((button) => {
  button.addEventListener('click', () => {
    if (button.dataset.lang === lang) return;
    lang = button.dataset.lang;
    try { localStorage.setItem('despertar-lang', lang); } catch { /* ignore */ }
    applyLanguage();
    scene?.setLanguage(lang);
  });
});

/* ---------- consultation request ---------- */
const dialog = document.getElementById('consult');
const form = document.getElementById('consultForm');
const done = document.getElementById('consultDone');

document.getElementById('openConsult').addEventListener('click', () => {
  form.hidden = false;
  done.hidden = true;
  dialog.showModal();
});
document.getElementById('closeConsult').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  let firstInvalid = null;
  for (const field of form.querySelectorAll('input[required], textarea[required]')) {
    const ok = field.checkValidity() && field.value.trim() !== '';
    field.classList.toggle('invalid', !ok);
    field.setAttribute('aria-invalid', String(!ok));
    if (!ok && !firstInvalid) firstInvalid = field;
  }
  if (firstInvalid) { firstInvalid.focus(); return; }

  const lines = [
    t('wa.greeting'),
    '',
    `${t('wa.name')}: ${data.name.trim()}`,
    `${t('wa.email')}: ${data.email.trim()}`,
    data.phone.trim() ? `${t('wa.phone')}: ${data.phone.trim()}` : null,
    `${t('wa.method')}: ${t('form.method.' + data.method)}`,
    '',
    `${t('wa.guidance')}:`,
    data.guidance.trim(),
  ].filter((l) => l !== null);
  const url = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(lines.join('\n'))}`;
  window.open(url, '_blank', 'noopener');

  document.getElementById('doneTitle').textContent = t('form.done.title').replace('{name}', data.name.trim().split(/\s+/)[0]);
  document.getElementById('doneRetry').href = url;
  form.hidden = true;
  done.hidden = false;
  done.focus();
  form.reset();
});
