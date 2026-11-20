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

// Pacing: how much scrolling (in screen heights x 100) each part of the
// story takes. P keeps its meaning (the film is rendered against it); this
// only decides how far the visitor scrolls to move through each part, so a
// slow scroll never rushes from one page to the next. Every open page gets
// a long, calm stretch to read, and each page turn plays over about a
// screen of scrolling.
const HOLD = 135;   // reading an open spread
const TURN = 95;    // one page turning
function paceKnots() {
  const knots = [[0, 0], [T.arrivalEnd, 100], [T.openEnd, 150], [T.firstTurn, HOLD]];
  for (let i = 0; i < N_LEAVES; i++) {
    const start = T.firstTurn + i * T.turnEvery;
    if (i > 0) knots.push([start, HOLD]);
    knots.push([start + T.turnLength, TURN]);
  }
  knots.push([0.8, HOLD], [T.fadeStart, 120], [1, 100]);
  // turn [P, segment length] pairs into [P, scroll position] knots
  let s = 0;
  return knots.map(([p, len]) => [p, (s += len)]);
}
const KNOTS = paceKnots();
export const JOURNEY_SCROLL = KNOTS[KNOTS.length - 1][1];   // in vh

// Scroll progress (0..1 through the journey) to story progress P.
export function scrollToP(s) {
  const x = clamp01(s) * JOURNEY_SCROLL;
  for (let i = 1; i < KNOTS.length; i++) {
    const [p1, s1] = KNOTS[i];
    if (x <= s1) {
      const [p0, s0] = KNOTS[i - 1];
      return s1 > s0 ? lerp(p0, p1, (x - s0) / (s1 - s0)) : p1;
    }
  }
  return 1;
}
