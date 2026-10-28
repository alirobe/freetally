// Small celebrations. All of it stands down when the device asks for reduced motion.

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function bump(el, up) {
  if (reduced()) return;
  el.classList.remove('bump-up', 'bump-down');
  void el.offsetWidth; // restarts the animation when taps come quickly
  el.classList.add(up ? 'bump-up' : 'bump-down');
}

// A "+1" that rises from the button that was tapped.
export function floatFrom(button, text, up) {
  if (reduced()) return;
  const r = button.getBoundingClientRect();
  const span = document.createElement('span');
  span.className = `float ${up ? 'up' : 'down'}`;
  span.textContent = text;
  span.style.left = `${r.left + r.width / 2}px`;
  span.style.top = `${r.top + r.height / 3}px`;
  document.body.append(span);
  span.addEventListener('animationend', () => span.remove());
}

const PALETTES = {
  hundred: ['#1f6f4a', '#4fb385', '#e8b04a', '#ef8a7e', '#5b8def'],
  capacity: ['#b3372b', '#ef8a7e', '#e8b04a', '#9a5b00'],
  egg: ['#e8443a', '#f39c12', '#f1c40f', '#2ecc71', '#3498db', '#9b59b6'],
};

export function celebrate({ kind, text }) {
  banner(text, kind);
  if (!reduced()) confetti(PALETTES[kind] ?? PALETTES.hundred, kind === 'capacity' ? 90 : 160);
}

function banner(text, kind) {
  const el = document.createElement('div');
  el.className = `banner ${kind}`;
  el.setAttribute('role', 'status');
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => el.remove(), 2600);
}

function confetti(colors, count) {
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  document.body.append(canvas);
  const dpr = devicePixelRatio || 1;
  const w = innerWidth;
  const h = innerHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const pieces = Array.from({ length: count }, () => ({
    x: w / 2 + (Math.random() - 0.5) * w * 0.4,
    y: h * 0.4,
    vx: (Math.random() - 0.5) * 14,
    vy: -Math.random() * 13 - 5,
    size: 6 + Math.random() * 6,
    rot: Math.random() * Math.PI,
    spin: (Math.random() - 0.5) * 0.3,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));
  const start = performance.now();
  const life = 2400;
  function frame(now) {
    const t = now - start;
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = Math.max(0, 1 - t / life);
    for (const p of pieces) {
      p.vy += 0.35;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.spin;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    }
    if (t < life) requestAnimationFrame(frame);
    else canvas.remove();
  }
  requestAnimationFrame(frame);
}

// Digits that roll like a mechanical counter.
export function odometer(el) {
  let shown = '';
  return (value) => {
    const text = value.toLocaleString();
    el.setAttribute('aria-label', text);
    if (text === shown) return;
    const rebuild = text.length !== shown.length || reduced();
    if (rebuild) {
      el.replaceChildren(
        ...[...text].map((ch) => {
          if (!/\d/.test(ch)) {
            const span = document.createElement('span');
            span.textContent = ch;
            span.setAttribute('aria-hidden', 'true');
            return span;
          }
          const digit = document.createElement('span');
          digit.className = 'odo-digit';
          digit.setAttribute('aria-hidden', 'true');
          const strip = document.createElement('span');
          strip.className = 'odo-strip';
          strip.textContent = '0123456789';
          digit.append(strip);
          return digit;
        }),
      );
      el.classList.add('odo-instant');
    }
    const strips = el.querySelectorAll('.odo-strip');
    let i = 0;
    for (const ch of text) {
      if (/\d/.test(ch)) strips[i++].style.transform = `translateY(${-Number(ch)}em)`;
    }
    if (rebuild) requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('odo-instant')));
    shown = text;
  };
}

// Sound, for the big screen. Browsers only allow audio after a tap, so it starts off.
let audio = null;
let lastTick = 0;

export async function setSound(on) {
  if (on) {
    audio ??= new AudioContext();
    await audio.resume();
  } else if (audio) {
    await audio.suspend();
  }
}

const soundOn = () => audio?.state === 'running';

function blip(freq, duration, volume, delay = 0) {
  const t = audio.currentTime + delay;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(volume, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + duration + 0.05);
}

export function tick(up) {
  // A busy door could send dozens of changes a second; one tick per 80ms is plenty.
  if (!soundOn() || performance.now() - lastTick < 80) return;
  lastTick = performance.now();
  blip(up ? 880 : 520, 0.06, 0.08);
}

export function chime(kind) {
  if (!soundOn()) return;
  const notes = kind === 'capacity' ? [784, 659, 523] : kind === 'egg' ? [659, 784, 659, 1047] : [523, 659, 784, 1047];
  notes.forEach((f, i) => blip(f, 0.35, 0.12, i * 0.12));
}
