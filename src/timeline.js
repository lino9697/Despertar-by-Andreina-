// Shared scroll timeline. P is the scroll progress (0..1) through the journey.
export const N_LEAVES = 5; // five turning leaves = six spreads

export const T = {
  arrivalEnd: 0.1,
  openStart: 0.1,
  openEnd: 0.25,
  firstTurn: 0.325,
  turnEvery: 0.09,
  turnLength: 0.04,
  brightStart: 0.795,
  brightEnd: 0.86,
  fadeStart: 0.9,
};

export const clamp01 = (x) => Math.min(1, Math.max(0, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (t) => {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
};
export const smoother = (t) => {
  t = clamp01(t);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
export const range = (p, a, b) => clamp01((p - a) / (b - a));

// Scroll window during which spread k (0..N_LEAVES) lies open and readable.
export function spreadWindow(k) {
  const start = k === 0 ? T.openEnd - 0.02 : T.firstTurn + (k - 1) * T.turnEvery + T.turnLength;
  const end = k === N_LEAVES ? 0.8 : T.firstTurn + k * T.turnEvery;
  return [start, end];
}

export const turnProgress = (p, i) => {
  const start = T.firstTurn + i * T.turnEvery;
  return range(p, start, start + T.turnLength);
};
