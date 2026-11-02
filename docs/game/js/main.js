import * as T from 'three';
import {COINS, CROPS, LAND, START_USD} from './config.js';
import {S} from './strings.js';

const $ = id => document.getElementById(id), pick = a => a[Math.random() * a.length | 0];
const back = t => 1 + 3.2 * (t - 1) ** 3 + 2.2 * (t - 1) ** 2; // overshoot easing
const fmt = n => n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(n < .01 ? 6 : 4);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const px = {}, P0 = {}, prev = {};
COINS.forEach(c => px[c.s] = prev[c.s] = P0[c.s] = c.p);

// ---------- state + save ----------
const K = 'cryptofarm1';
let bal = {}, plots = [], seed = 0, mute = false, trend = 0, tmsg = 0;
try { const d = JSON.parse(localStorage.getItem(K)); if (d && d.bal && Array.isArray(d.plots) && d.plots.length) { bal = d.bal; plots = d.plots; } } catch (e) {}
if (!plots.length) {
  COINS.forEach(c => bal[c.s] = START_USD / c.p);
  plots = [...Array(6)].map((_, i) => ({u: i < 2, c: -1, t: 0}));
}
const save = () => { try { localStorage.setItem(K, JSON.stringify({bal, plots})); } catch (e) {} };
const can = (s, usd) => bal[s] * px[s] >= usd - 1e-9;
const pay = (s, usd) => can(s, usd) && (bal[s] = Math.max(0, bal[s] - usd / px[s]), true);
const say = t => { $('tk').textContent = t; tmsg = Date.now() + 4000; };

// ---------- audio (WebAudio, no files) ----------
let ac;
function beep(f = 520, d = .08, type = 'triangle', v = .15) {
  if (mute) return;
  try {
    ac = ac || new AudioContext();
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.value = f;
    g.gain.setValueAtTime(v, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(.001, ac.currentTime + d);
    o.connect(g).connect(ac.destination); o.start(); o.stop(ac.currentTime + d);
  } catch (e) {}
}
const sfx = {
  plant:  () => beep(180, .1, 'sine', .2),
  harvest:() => { beep(660, .09); setTimeout(() => beep(880, .14), 80); },
  unlock: () => [520, 660, 780].forEach((f, i) => setTimeout(() => beep(f, .1), i * 70)),
  coin:   () => beep(980, .06, 'square', .08),
  err:    () => beep(140, .18, 'sawtooth', .12),
};

// ---------- 3D scene ----------
const cv = $('c'), R = new T.WebGLRenderer({canvas: cv, antialias: true});
R.shadowMap.enabled = true; R.setPixelRatio(Math.min(devicePixelRatio, 2));
const sc = new T.Scene();
sc.fog = new T.Fog(0xbfe8ff, 18, 46);
const cam = new T.OrthographicCamera(-1, 1, 1, -1, .1, 120);
const camFocus = new T.Vector3(0, 0, 0);   // kamera lihat ke sini (lerp)
const panOff = new T.Vector3();            // offset dari drag kanan
let zoom = 7, started = false;
function fit() {
  const a = innerWidth / innerHeight; R.setSize(innerWidth, innerHeight, false);
  Object.assign(cam, {left: -zoom * a, right: zoom * a, top: zoom, bottom: -zoom}); cam.updateProjectionMatrix();
}
const hemi = new T.HemisphereLight(0xffffff, 0x88aa66, 1.1); sc.add(hemi);
const sun = new T.DirectionalLight(0xffffff, 1.6); sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024); Object.assign(sun.shadow.camera, {left: -12, right: 12, top: 12, bottom: -12}); sc.add(sun);

// toon material + thin outline (inverted hull)
function mk(g, col, o = 1.05) {
  const m = new T.Mesh(g, new T.MeshToonMaterial({color: col})); m.castShadow = m.receiveShadow = true;
  if (o) m.add(new T.Mesh(g, new T.MeshBasicMaterial({color: 0x2a2a2a, side: T.BackSide}))).children[0].scale.setScalar(o);
  return m;
}
const ground = mk(new T.BoxGeometry(17, .4, 17), 0x7ccf5b, 0); ground.position.y = -.2; sc.add(ground);

// ---------- partikel (pool sederhana) ----------
const partGeo = new T.BoxGeometry(.09, .09, .09), partMats = {}, parts = [];
function burst(pos, col, n = 14, spd = 2.4, up = 2.2) {
  const mat = partMats[col] || (partMats[col] = new T.MeshBasicMaterial({color: col, transparent: true}));
  for (let i = 0; i < n; i++) {
    const m = new T.Mesh(partGeo, mat);
    m.position.copy(pos);
    const a = Math.random() * Math.PI * 2, r = Math.random() * spd;
    m.userData.v = new T.Vector3(Math.cos(a) * r, Math.random() * up + .6, Math.sin(a) * r);
    m.userData.life = 1; sc.add(m); parts.push(m);
  }
}

// ---------- emoji sprite ----------
function emoSprite(emoji, s = .55) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'); x.font = '48px serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(emoji, 32, 34);
  const sp = new T.Sprite(new T.SpriteMaterial({map: new T.CanvasTexture(c), transparent: true, depthWrite: false}));
  sp.scale.set(s, s, s); return sp;
}

// ---------- langit: matahari, bulan, bintang ----------
const sunBall = new T.Mesh(new T.SphereGeometry(1.6, 12, 10), new T.MeshBasicMaterial({color: 0xffe9a8}));
const moonBall = new T.Mesh(new T.SphereGeometry(1.1, 10, 8), new T.MeshBasicMaterial({color: 0xdfe6ff}));
sc.add(sunBall, moonBall);
const starGeo = new T.BufferGeometry();
starGeo.setAttribute('position', new T.BufferAttribute(new Float32Array([...Array(260)].flatMap(() => {
  const a = Math.random() * Math.PI * 2, e = Math.random() * .8 + .1, r = 55;
  return [Math.cos(a) * r * e, Math.sin(e * 1.4) * r * .8 + 4, Math.sin(a) * r * e];
}), 3)));
const stars = new T.Points(starGeo, new T.PointsMaterial({color: 0xffffff, size: .5, transparent: true, opacity: 0, depthWrite: false}));
sc.add(stars);
// kunang-kunang (malam) & kupu-kupu (siang)
const flies = [...Array(14)].map(() => { const s = emoSprite('✨', .22); s.material.opacity = 0; sc.add(s); return {s, a: Math.random() * 9, r: 2 + Math.random() * 4, y: .4 + Math.random() * .8, sp: .3 + Math.random() * .5}; });
const butts = [...Array(5)].map(() => { const s = emoSprite('🦋', .4); sc.add(s); return {s, a: Math.random() * 9, r: 3 + Math.random() * 3, y: 1 + Math.random() * 1.2, sp: .5 + Math.random() * .5}; });

// ---------- awan + hujan ----------
const clouds = [...Array(7)].map(() => {
  const g = new T.Group();
  for (let i = 0; i < 3; i++) {
    const b = mk(new T.SphereGeometry(.7 + Math.random() * .5, 8, 6), 0xffffff, 0);
    b.position.set(i * .9 - .9, Math.random() * .2, Math.random() * .4 - .2); b.scale.y = .6; g.add(b);
  }
  g.position.set(Math.random() * 30 - 15, 8 + Math.random() * 3, Math.random() * 24 - 12);
  sc.add(g); return g;
});
const RAIN_N = 420, rainPos = new Float32Array(RAIN_N * 3);
for (let i = 0; i < RAIN_N; i++) { rainPos[i * 3] = Math.random() * 30 - 15; rainPos[i * 3 + 1] = Math.random() * 14; rainPos[i * 3 + 2] = Math.random() * 30 - 15; }
const rainGeo = new T.BufferGeometry(); rainGeo.setAttribute('position', new T.BufferAttribute(rainPos, 3));
const rain = new T.Points(rainGeo, new T.PointsMaterial({color: 0x9db9d8, size: .09, transparent: true, opacity: .7}));
rain.visible = false; sc.add(rain);
let weather = 'clear', wxTimer = 40 + Math.random() * 40;

// ---------- plots ----------
function cropMesh(i) {
  const g = new T.Group(), col = CROPS[i].col;
  if (i == 0) for (let k = 0; k < 5; k++) {
    const s = mk(new T.CylinderGeometry(.03, .04, .9, 6), 0xc9b037, 0);
    s.position.set(Math.sin(k * 1.9) * .45, .45, Math.cos(k * 1.9) * .45);
    const h = mk(new T.SphereGeometry(.1, 8, 6), col, 0); h.scale.y = 2; h.position.y = .5; s.add(h); g.add(s);
  }
  if (i == 1) {
    const s = mk(new T.CylinderGeometry(.07, .09, 1.2, 8), 0x4caf50); s.position.y = .6;
    const c = mk(new T.CapsuleGeometry(.12, .3, 4, 8), col); c.position.set(.14, .25, 0); s.add(c); g.add(s);
  }
  if (i == 2) {
    const b = mk(new T.SphereGeometry(.45, 12, 10), 0x3f9b45); b.position.y = .4; g.add(b);
    for (let k = 0; k < 4; k++) {
      const t = mk(new T.SphereGeometry(.14, 10, 8), col, 0);
      t.position.set(Math.sin(k * 1.6) * .42, .45 + (k % 2) * .2, Math.cos(k * 1.6) * .42); g.add(t);
    }
  }
  if (i == 3) {
    const p = mk(new T.SphereGeometry(.5, 14, 12), col); p.scale.y = .75; p.position.y = .35;
    const s = mk(new T.CylinderGeometry(.05, .07, .22, 6), 0x3f7d2c, 0); s.position.y = .75; g.add(p, s);
  }
  return g;
}
const PL = plots.map((p, i) => {
  const g = new T.Group(); g.position.set((i % 3 - 1) * 2.5, 0, ((i / 3 | 0) - .5) * 2.5);
  const soil = mk(new T.BoxGeometry(2.1, .3, 2.1), 0x8b5a2b); soil.position.y = .15; soil.userData.i = i;
  g.add(soil); sc.add(g); return {g, soil, m: null, mc: -2, ring: null, icon: null, ready: false};
});
function sync(i) {
  const p = plots[i], o = PL[i];
  o.soil.material.color.set(p.u ? 0x8b5a2b : 0x9aa0a6);
  if (o.mc !== p.c) {
    if (o.m) o.g.remove(o.m);
    o.m = p.c >= 0 ? cropMesh(p.c) : null;
    if (o.m) { o.m.position.y = .3; o.m.userData.pop = Date.now(); o.g.add(o.m); }
    o.mc = p.c; o.ready = false;
    if (o.ring) { o.g.remove(o.ring); o.ring = null; }
    if (o.icon) { o.g.remove(o.icon); o.icon = null; }
  }
  // ikon gembok melayang di plot terkunci
  if (!p.u && !o.icon) { o.icon = emoSprite('🔒', .5); o.icon.position.y = 1.1; o.g.add(o.icon); }
}

// ---------- decor: trees, market stall, hen ----------
[[-5, -4], [5, -3.5], [-5.5, 1], [5.5, 2], [3, -5.5]].forEach(([x, z]) => {
  const t = mk(new T.CylinderGeometry(.12, .16, .7, 8), 0x7a4a24, 0); t.position.set(x, .35, z);
  const l = mk(new T.ConeGeometry(.8, 1.8, 8), 0x2e9e4f); l.position.y = 1.1; t.add(l); sc.add(t);
});
const stall = new T.Group(), cnt = mk(new T.BoxGeometry(1.8, .8, 1), 0xb07a45), roof = mk(new T.BoxGeometry(2.3, .12, 1.5), 0xe5483c);
cnt.position.y = .4; roof.position.y = 1.7; stall.add(cnt, roof);
[-.95, .95].forEach(x => { const p = mk(new T.CylinderGeometry(.05, .05, 1.7, 6), 0x7a4a24, 0); p.position.set(x, .85, -.5); stall.add(p); });
stall.position.set(-4.6, 0, -1.8); sc.add(stall);
const hen = new T.Group(), hb = mk(new T.SphereGeometry(.28, 12, 10), 0xffffff), hh = mk(new T.SphereGeometry(.15, 10, 8), 0xffffff, 0), cb = mk(new T.BoxGeometry(.05, .1, .1), 0xe53935, 0);
hb.scale.set(1, .9, 1.2); hh.position.set(0, .25, .25); cb.position.set(0, .4, .25); hen.add(hb, hh, cb); hen.position.set(-3.6, .35, 2.6); sc.add(hen);

// ---------- farmer ----------
const F = new T.Group(), legs = [0, 1].map(s => {
  const l = mk(new T.CylinderGeometry(.09, .09, .35, 8), 0x3b5fc0, 0); l.geometry.translate(0, -.17, 0);
  l.position.set(s ? .13 : -.13, .38, 0); F.add(l); return l;
});
const fb = mk(new T.CapsuleGeometry(.26, .35, 4, 10), 0x4a78e0), fh = mk(new T.SphereGeometry(.22, 14, 12), 0xffd2a8),
  hat = mk(new T.CylinderGeometry(.42, .42, .05, 16), 0xf2c94c, 0), hat2 = mk(new T.CylinderGeometry(.2, .24, .2, 14), 0xf2c94c, 0);
fb.position.y = .75; fh.position.y = 1.3; hat.position.y = 1.48; hat2.position.y = 1.58;
F.add(fb, fh, hat, hat2); F.position.set(0, 0, 3.4); sc.add(F);
let tgt = null, after = null, walk = 0;
const go = (v, f) => { tgt = v; after = f; };
const stand = i => PL[i].g.position.clone().add(new T.Vector3(0, 0, 1.6));

// ---------- aksi game ----------
function fly(txt, v, col = '#1a8a44') {
  const p = v.clone().project(cam), x = (p.x + 1) / 2 * innerWidth, y = (1 - p.y) / 2 * innerHeight, d = document.createElement('div');
  d.className = 'fly'; d.textContent = txt; d.style.color = col; d.style.left = x + 'px'; d.style.top = y + 'px'; document.body.appendChild(d);
  const b = $('wb').getBoundingClientRect();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    d.style.transform = `translate(${b.left - x + 20}px,${b.top - y}px) scale(.4)`; d.style.opacity = .2;
  }));
  setTimeout(() => d.remove(), 900);
}
function harvest(i) {
  const p = plots[i]; if (p.c < 0) return;
  const c = CROPS[p.c], coin = pick(COINS).s, a = c.sell / px[coin];
  bal[coin] += a; p.c = -1; sync(i);
  burst(PL[i].g.position.clone().setY(.8), c.col, 16, 2.6, 2.6);
  burst(PL[i].g.position.clone().setY(.8), 0xffd24f, 8, 2, 3);
  fly(`${c.e} +${fmt(a)} ${coin}`, PL[i].g.position.clone().setY(1.4));
  say(pick(S.sold).replace('{c}', coin).replace('{a}', fmt(a))); sfx.harvest();
}
function doAction(i) {
  const p = plots[i];
  if (!p.u) {
    if (!can(LAND.coin, LAND.cost)) { say(S.locked(LAND.cost, LAND.coin)); sfx.err(); return; }
    if (!pay(LAND.coin, LAND.cost)) { say(S.poor(LAND.coin)); sfx.err(); return; }
    p.u = true; PL[i].g.userData.pop = Date.now(); sync(i);
    burst(PL[i].g.position.clone().setY(.5), 0xffd24f, 20, 3, 3.4);
    sfx.unlock(); say(S.unlocked); return;
  }
  if (p.c < 0) {
    const c = CROPS[seed];
    if (!can(c.coin, c.cost)) { say(S.poor(c.coin)); sfx.err(); return; }
    if (!pay(c.coin, c.cost)) { say(S.poor(c.coin)); sfx.err(); return; }
    p.c = seed; p.t = Date.now(); sync(i);
    burst(PL[i].g.position.clone().setY(.3), 0x8b5a2b, 10, 1.6, 1.4);
    sfx.plant(); say(S.planted); return;
  }
  const growMs = CROPS[p.c].t * 1000 / (weather === 'rain' ? 1.5 : 1); // hujan = tumbuh 1.5x
  const left = Math.ceil((growMs - (Date.now() - p.t)) / 1000);
  if (left > 0) { say(S.grow(left) + (weather === 'rain' ? ' 🌧️ bonus!' : '')); return; }
  harvest(i);
}
// tap plot: kalau jauh → jalan dulu, sampai lalu aksi otomatis
let pending = -1;
function tapPlot(i) {
  const d = F.position.distanceTo(PL[i].g.position);
  if (d > 2.1) { pending = i; go(stand(i), () => { if (pending === i) { doAction(i); pending = -1; } }); }
  else doAction(i);
}

// ---------- UI: crop bar, wallet, chips, action button ----------
$('bar').innerHTML = CROPS.map((c, i) => `<button data-i="${i}">${c.e}<b>${c.n}</b><small>$${c.cost} in ${c.coin}</small></button>`).join('');
const mark = () => [...$('bar').children].forEach((b, i) => b.classList.toggle('on', i == seed));
$('bar').onclick = e => { const b = e.target.closest('button'); if (b) { seed = +b.dataset.i; mark(); beep(500, .05); updateAct(); } };
mark();

const wp = $('wp'), opts = COINS.map(c => `<option>${c.s}</option>`).join('');
wp.innerHTML = `<svg id="spark" viewBox="0 0 60 22" preserveAspectRatio="none"><polyline id="spl" fill="none" stroke="#1a8a44" stroke-width="1.2" points=""/></svg><div id="wl"></div><div id="sw"><b>Swap</b><select id="sf">${opts}</select>→<select id="st">${opts}</select><input id="sa" type="number" min="1" value="10" aria-label="Amount in USD"><button id="sb">Swap $</button><small>Gas fee: 1% (min $0.50)</small></div>`;
$('sf').value = 'USDT'; $('st').value = 'DOGE';
const worthHist = [];
function renderW() {
  $('wl').innerHTML = COINS.map(c => {
    const d = px[c.s] - prev[c.s], up = d >= 0;
    return `<div class="r"><i style="background:${c.c}"></i><b>${c.s}</b><span>${fmt(bal[c.s])}</span><em>$${fmt(bal[c.s] * px[c.s])}</em><u class="${up ? 'up' : 'dn'}">${up ? '▲' : '▼'} $${fmt(px[c.s])}</u></div>`;
  }).join('');
  // sparkline total worth
  const w = COINS.reduce((s, c) => s + bal[c.s] * px[c.s], 0);
  worthHist.push(w); if (worthHist.length > 60) worthHist.shift();
  const mn = Math.min(...worthHist), mx = Math.max(...worthHist), rg = Math.max(1, mx - mn);
  $('spl').setAttribute('points', worthHist.map((v, i) => `${i},${21 - (v - mn) / rg * 19}`).join(' '));
}
const hud = () => $('wt').textContent = '$' + COINS.reduce((s, c) => s + bal[c.s] * px[c.s], 0).toFixed(0);
$('wb').onclick = () => { wp.classList.toggle('hide'); renderW(); };
$('sb').onclick = () => {
  const f = $('sf').value, t = $('st').value, u = +$('sa').value;
  if (f == t || !(u > 0)) return say(S.same);
  if (!can(f, u)) return say(S.poor(f));
  const fee = Math.max(.5, u * .01); if (fee >= u) return say(S.tiny);
  pay(f, u); bal[t] += (u - fee) / px[t]; renderW(); hud(); beep(600);
  say(fee > u * .2 ? S.badSwap : S.swapOk);
};
$('mu').onclick = () => { mute = !mute; $('mu').textContent = mute ? '🔇' : '🔊'; };
$('ld').textContent = S.loading; $('tut').textContent = S.tut; $('go').textContent = S.start; $('sim').textContent = S.sim;
$('go').onclick = () => { $('title').remove(); started = true; beep(520); say('Joystick kiri untuk jalan. Tombol ✋ untuk aksi.'); };

// chip waktu & cuaca
function updateChips() {
  const h = Math.floor(dayT * 24), m = Math.floor((dayT * 24 - h) * 60);
  const night = dayT < .22 || dayT > .8;
  $('chip-time').textContent = `${night ? '🌙' : dayT < .3 || dayT > .72 ? '🌅' : '☀️'} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  $('chip-wx').textContent = weather === 'rain' ? '🌧️ tumbuh +50%' : '☀️ cerah';
}

// tombol aksi kontekstual (dekat plot)
let near = -1;
function nearestPlot() {
  let best = -1, bd = 1.9;
  PL.forEach((o, i) => { const d = F.position.distanceTo(o.g.position); if (d < bd) { bd = d; best = i; } });
  return best;
}
function updateAct() {
  const i = near;
  if (i < 0 || !started) { $('act').classList.add('hide'); return; }
  const p = plots[i], b = $('act'); b.classList.remove('hide');
  if (!p.u) { b.innerHTML = `🔒<small>Buka $${LAND.cost} ${LAND.coin}</small>`; b.dataset.i = i; return; }
  if (p.c < 0) { const c = CROPS[seed]; b.innerHTML = `${c.e}<small>Tanam $${c.cost} ${c.coin}</small>`; b.dataset.i = i; return; }
  const growMs = CROPS[p.c].t * 1000 / (weather === 'rain' ? 1.5 : 1);
  const left = Math.ceil((growMs - (Date.now() - p.t)) / 1000);
  if (left > 0) { b.innerHTML = `⏳<small>${left}s${weather === 'rain' ? ' 🌧️' : ''}</small>`; b.dataset.i = i; return; }
  b.innerHTML = `✋<small>Panen!</small>`; b.dataset.i = i;
}
$('act').onclick = () => { const i = +$('act').dataset.i; if (i >= 0) { doAction(i); updateAct(); } };

// ---------- input: joystick analog (kiri) + pan kamera (kanan) + keyboard ----------
const stick = {x: 0, y: 0}, keys = {};
const stickEl = $('stick'), knobEl = $('knob');
let stickId = null, panId = null, moved = 0, lastPan = null;
const STICK_R = 52;
function stickStart(e) {
  stickId = e.pointerId; stickEl.classList.add('on');
  knobEl.style.transform = 'translate(-50%,-50%)';
}
function stickMove(e) {
  if (e.pointerId !== stickId) return;
  const cx = 76, cy = innerHeight - 76; // pusat stick (kiri-bawah, sama dgn posisi CSS)
  let dx = e.clientX - cx, dy = e.clientY - cy;
  const d = Math.hypot(dx, dy);
  if (d > STICK_R) { dx = dx / d * STICK_R; dy = dy / d * STICK_R; }
  knobEl.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  stick.x = dx / STICK_R; stick.y = dy / STICK_R;
}
function stickEnd() { stickId = null; stick.x = stick.y = 0; stickEl.classList.remove('on'); knobEl.style.transform = 'translate(-50%,-50%)'; }

cv.addEventListener('pointerdown', e => {
  cv.setPointerCapture(e.pointerId);
  if (e.clientX < innerWidth * .5 && stickId === null) stickStart(e);
  else if (panId === null) { panId = e.pointerId; lastPan = [e.clientX, e.clientY]; moved = 0; }
});
cv.addEventListener('pointermove', e => {
  if (e.pointerId === stickId) { stickMove(e); return; }
  if (e.pointerId === panId && lastPan) {
    const dx = e.clientX - lastPan[0], dy = e.clientY - lastPan[1]; moved += Math.abs(dx) + Math.abs(dy);
    const u = 2 * zoom / innerHeight * .7;
    panOff.x = clamp(panOff.x + (-dx - dy) * u, -6, 6);
    panOff.z = clamp(panOff.z + (dx - dy) * u, -6, 6);
    lastPan = [e.clientX, e.clientY];
  }
});
function endPointer(e) {
  if (e.pointerId === stickId) stickEnd();
  if (e.pointerId === panId) {
    // tap (bukan drag) di kanan → raycast plot
    if (moved < 9 && started) {
      const ray = new T.Raycaster();
      ray.setFromCamera(new T.Vector2(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), cam);
      const h = ray.intersectObjects(PL.map(o => o.soil), false)[0];
      if (h) tapPlot(h.object.userData.i);
    }
    panId = null; lastPan = null;
  }
}
cv.addEventListener('pointerup', endPointer);
cv.addEventListener('pointercancel', e => { if (e.pointerId === stickId) stickEnd(); if (e.pointerId === panId) { panId = null; lastPan = null; } });
cv.addEventListener('wheel', e => { zoom = clamp(zoom * (1 + Math.sign(e.deltaY) * .08), 4, 11); fit(); }, {passive: true});
addEventListener('keydown', e => { keys[e.key.toLowerCase()] = true; if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(e.key.toLowerCase())) e.preventDefault(); });
addEventListener('keyup', e => keys[e.key.toLowerCase()] = false);
addEventListener('resize', fit);

// ---------- simulasi harga ----------
setInterval(() => {
  if (Math.random() < .06) trend = pick([-1, 0, 1]) * .006;
  COINS.forEach(c => {
    prev[c.s] = px[c.s];
    if (c.st) return px[c.s] = 1 + (Math.random() - .5) * .001;
    const v = c.s == 'BTC' || c.s == 'ETH' ? .6 : 1, n = px[c.s] * (1 + (Math.random() - .5) * .025 * v + trend * v);
    px[c.s] = Math.min(P0[c.s] * 3, Math.max(P0[c.s] * .3, n));
  });
  hud(); if (!wp.classList.contains('hide')) renderW();
  if (Date.now() > tmsg && Math.random() < .2) $('tk').textContent = pick(S.news);
}, 1000);
setInterval(() => { updateChips(); if (near >= 0) updateAct(); }, 1000);
setInterval(save, 3000); addEventListener('beforeunload', save);

// ---------- siklus siang/malam ----------
let dayT = .32; // mulai pagi
const SKY = [ // t, langit, matahari, intensitas, hemi
  [0.00, 0x0b1026, 0x2a3a6a, .12, .3],
  [0.20, 0x0b1026, 0x2a3a6a, .12, .3],
  [0.26, 0xff9e5e, 0xffb36b, .9, .7],
  [0.38, 0x8ec9ee, 0xfff6e0, 1.7, 1.1],
  [0.62, 0x8ec9ee, 0xfff6e0, 1.7, 1.1],
  [0.74, 0xff8e5e, 0xff9b5e, .8, .7],
  [0.82, 0x3a2a5e, 0x5a4a8a, .3, .45],
  [1.00, 0x0b1026, 0x2a3a6a, .12, .3],
];
const cA = new T.Color(), cB = new T.Color();
function skyLerp(t) {
  for (let i = 1; i < SKY.length; i++) {
    if (t <= SKY[i][0]) {
      const a = SKY[i - 1], b = SKY[i], k = (t - a[0]) / (b[0] - a[0]);
      const sky = cA.setHex(a[1]).clone().lerp(cB.setHex(b[1]), k);
      const sunCol = new T.Color(a[2]).lerp(new T.Color(b[2]), k);
      return {sky, sunCol, int: lerp(a[3], b[3], k), hemi: lerp(a[4], b[4], k)};
    }
  }
  return {sky: new T.Color(0x0b1026), sunCol: new T.Color(0x2a3a6a), int: .12, hemi: .3};
}

// ---------- main loop ----------
let last = performance.now();
const vel = new T.Vector3();
function loop(now) {
  const dt = Math.min(.05, (now - last) / 1000); last = now; const D = Date.now();

  // --- waktu & cuaca ---
  dayT = (dayT + dt / 240) % 1; // 1 siklus = 4 menit
  wxTimer -= dt;
  if (wxTimer <= 0) {
    weather = weather === 'rain' ? 'clear' : 'rain';
    wxTimer = weather === 'rain' ? 25 + Math.random() * 25 : 45 + Math.random() * 50;
    rain.visible = weather === 'rain';
    say(weather === 'rain' ? '🌧️ Hujan! Crop tumbuh 50% lebih cepat.' : '☀️ Cerah lagi.');
    updateChips();
  }
  const sk = skyLerp(dayT);
  sc.background = sk.sky; sc.fog.color = sk.sky;
  const sa = (dayT - .25) * Math.PI * 2, sy = Math.sin(sa), sx = -Math.cos(sa);
  sun.position.set(sx * 18, Math.max(sy * 18, .5), 8);
  sun.color = sk.sunCol; sun.intensity = sk.int * (weather === 'rain' ? .55 : 1);
  hemi.intensity = sk.hemi * (weather === 'rain' ? .7 : 1);
  sunBall.position.copy(sun.position).multiplyScalar(2.2);
  moonBall.position.set(-sx * 18, -sy * 18, -8);
  const nightF = clamp(-sy * 1.6, 0, 1);
  stars.material.opacity = nightF * .9;
  stars.position.copy(camFocus);
  // hujan
  if (weather === 'rain') {
    const rp = rainGeo.attributes.position.array;
    for (let i = 0; i < RAIN_N; i++) {
      rp[i * 3 + 1] -= dt * 14;
      if (rp[i * 3 + 1] < 0) { rp[i * 3] = camFocus.x + Math.random() * 30 - 15; rp[i * 3 + 1] = 13 + Math.random() * 3; rp[i * 3 + 2] = camFocus.z + Math.random() * 30 - 15; }
    }
    rainGeo.attributes.position.needsUpdate = true;
  }
  // awan
  clouds.forEach(c => { c.position.x += dt * .35; if (c.position.x > 16) c.position.x = -16; c.children.forEach(b => b.material.color.set(weather === 'rain' ? 0xaab4c0 : 0xffffff)); });

  // --- gerak farmer (analog) ---
  let ix = stick.x, iz = stick.y;
  if (keys['w'] || keys['arrowup']) iz -= 1; if (keys['s'] || keys['arrowdown']) iz += 1;
  if (keys['a'] || keys['arrowleft']) ix -= 1; if (keys['d'] || keys['arrowright']) ix += 1;
  const mag = Math.min(1, Math.hypot(ix, iz));
  if (tgt) { // mode jalan-ke-tujuan (tap plot): input manual membatalkan
    const d = tgt.clone().sub(F.position); d.y = 0;
    if (d.length() > .08) {
      const step = Math.min(3.4 * dt, d.length());
      F.position.addScaledVector(d.normalize(), step);
      walk += dt * 9;
      F.rotation.y += (((Math.atan2(d.x, d.z) - F.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * Math.min(1, dt * 12);
      F.position.y = Math.abs(Math.sin(walk)) * .1;
      legs[0].rotation.x = Math.sin(walk) * .7; legs[1].rotation.x = -Math.sin(walk) * .7;
    } else { F.position.y *= .8; legs.forEach(l => l.rotation.x *= .8); const f = after; tgt = after = null; f && f(); }
  } else if (mag > .08) {
    // arah stick: x = layar-x → dunia-x, y = layar-y → dunia-z (iso)
    const dir = new T.Vector3(ix, 0, iz).normalize().multiplyScalar(3.4 * mag);
    vel.lerp(dir, 1 - Math.exp(-dt * 9));
    F.position.addScaledVector(vel, dt);
    F.position.x = clamp(F.position.x, -7.4, 7.4); F.position.z = clamp(F.position.z, -7.4, 7.4);
    walk += vel.length() * dt * 3;
    const a = Math.atan2(vel.x, vel.z);
    F.rotation.y += (((a - F.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * Math.min(1, dt * 12);
    F.position.y = Math.abs(Math.sin(walk)) * .1;
    legs[0].rotation.x = Math.sin(walk) * .7; legs[1].rotation.x = -Math.sin(walk) * .7;
  } else {
    vel.multiplyScalar(Math.exp(-dt * 12));
    F.position.y *= .8; legs.forEach(l => l.rotation.x *= .8);
    fb.scale.y = 1 + .03 * Math.sin(D / 400);
  }

  // --- plot: tumbuh, ready fx ---
  PL.forEach((o, i) => {
    const p = plots[i], k = o.g.userData.pop ? Math.min(1, (D - o.g.userData.pop) / 450) : 1;
    o.g.scale.y = Math.max(.01, back(k));
    if (o.m) {
      const growMs = CROPS[p.c].t * 1000 / (weather === 'rain' ? 1.5 : 1);
      const pr = Math.min(1, (D - p.t) / growMs), b = back(Math.min(1, (D - o.m.userData.pop) / 500));
      const gs = .25 + .75 * pr, w = 1 - (b - 1) * .6;
      let y = gs * b;
      if (pr >= 1) y *= 1 + .06 * Math.sin(D / 180);
      o.m.scale.set(gs * w, Math.max(.01, y), gs * w);
      // ready: cincin glow + ikon ✨ melayang
      if (pr >= 1 && !o.ready) {
        o.ready = true;
        o.ring = new T.Mesh(new T.TorusGeometry(.85, .05, 8, 24), new T.MeshBasicMaterial({color: 0xffd24f, transparent: true, opacity: .85}));
        o.ring.rotation.x = Math.PI / 2; o.ring.position.y = .35; o.g.add(o.ring);
        o.icon = emoSprite('✨', .5); o.icon.position.y = 1.7; o.g.add(o.icon);
      }
      if (o.ready) {
        o.ring.material.opacity = .5 + .35 * Math.sin(D / 260);
        o.ring.scale.setScalar(1 + .05 * Math.sin(D / 260));
        o.icon.position.y = 1.7 + .12 * Math.sin(D / 300);
      }
    } else if (o.ready) { o.ready = false; if (o.ring) { o.g.remove(o.ring); o.ring = null; } if (o.icon) { o.g.remove(o.icon); o.icon = null; } }
    // ikon gembok melayang di plot terkunci
    if (!p.u && o.icon) o.icon.position.y = 1.1 + .08 * Math.sin(D / 400 + i);
  });

  // --- partikel ---
  for (let i = parts.length - 1; i >= 0; i--) {
    const m = parts[i];
    m.position.addScaledVector(m.userData.v, dt);
    m.userData.v.y -= 5 * dt;
    m.userData.life -= dt * 1.3;
    m.scale.setScalar(Math.max(.01, m.userData.life));
    m.rotation.x += dt * 6; m.rotation.y += dt * 4;
    if (m.userData.life <= 0) { sc.remove(m); parts.splice(i, 1); }
  }

  // --- kunang-kunang & kupu-kupu ---
  flies.forEach(f => {
    f.a += dt * f.sp;
    f.s.position.set(Math.cos(f.a) * f.r, f.y + Math.sin(f.a * 2.3) * .25, Math.sin(f.a) * f.r);
    f.s.material.opacity = nightF * (.5 + .5 * Math.sin(D / 200 + f.a));
  });
  butts.forEach(b => {
    b.a += dt * b.sp;
    b.s.position.set(Math.cos(b.a) * b.r, b.y + Math.sin(b.a * 2.3) * .25, Math.sin(b.a * b.sp) * b.r);
    b.s.material.opacity = clamp(1 - nightF * 1.4, 0, 1);
  });

  // --- hen idle ---
  hen.position.y = .35 + Math.abs(Math.sin(D / 330)) * .03; hen.rotation.y = Math.sin(D / 1500) * .6;
  hh.rotation.x = Math.sin(D / 250) > .8 ? .6 : 0;

  // --- kamera: follow farmer (mode main) / orbit (title) ---
  if (started) {
    camFocus.lerp(new T.Vector3(F.position.x + panOff.x, 0, F.position.z + panOff.z), 1 - Math.exp(-dt * 5));
    cam.position.set(camFocus.x + 10, 10, camFocus.z + 10); cam.lookAt(camFocus);
  } else {
    const a = D / 6000;
    camFocus.lerp(new T.Vector3(0, 0, 0), 1 - Math.exp(-dt * 2));
    cam.position.set(Math.cos(a) * 13, 8.5, Math.sin(a) * 13); cam.lookAt(camFocus);
  }

  // --- tombol aksi kontekstual ---
  const n = nearestPlot();
  if (n !== near) { near = n; updateAct(); }

  R.render(sc, cam); requestAnimationFrame(loop);
}
PL.forEach((_, i) => sync(i)); fit(); hud(); say(pick(S.news)); updateChips(); requestAnimationFrame(loop);

// expose buat testing
window.__CF = {S: {bal, plots, px}, F, stick, get dayT() { return dayT; }, get weather() { return weather; }, doAction, tapPlot, nearestPlot, get near() { return near; }};
