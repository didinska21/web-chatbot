import * as T from 'three';
import {COINS, CROPS, LAND, START_USD} from './config.js';
import {S} from './strings.js';

const $ = id => document.getElementById(id), pick = a => a[Math.random() * a.length | 0];
const back = t => 1 + 3.2 * (t - 1) ** 3 + 2.2 * (t - 1) ** 2; // overshoot easing
const fmt = n => n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(n < .01 ? 6 : 4);
const px = {}, P0 = {}, prev = {};
COINS.forEach(c => px[c.s] = prev[c.s] = P0[c.s] = c.p);

// ---------- state + save ----------
const K = 'cryptofarm1';
let bal = {}, plots = [], seed = 0, mute = false, trend = 0, tmsg = 0;
try { const d = JSON.parse(localStorage.getItem(K)); bal = d.bal; plots = d.plots; } catch (e) {}
if (!plots.length) {
  COINS.forEach(c => bal[c.s] = START_USD / c.p);
  plots = [...Array(6)].map((_, i) => ({u: i < 2, c: -1, t: 0}));
}
const save = () => { try { localStorage.setItem(K, JSON.stringify({bal, plots})); } catch (e) {} };
const can = (s, usd) => bal[s] * px[s] >= usd - 1e-9;
const pay = (s, usd) => can(s, usd) && (bal[s] = Math.max(0, bal[s] - usd / px[s]), true);
const say = t => { $('tk').textContent = t; tmsg = Date.now() + 4000; };

// ---------- audio ----------
let ac;
function beep(f = 520, d = .08) {
  if (mute) return;
  try {
    ac = ac || new AudioContext();
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = 'triangle'; o.frequency.value = f;
    g.gain.setValueAtTime(.15, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(.001, ac.currentTime + d);
    o.connect(g).connect(ac.destination); o.start(); o.stop(ac.currentTime + d);
  } catch (e) {}
}

// ---------- 3D scene ----------
const cv = $('c'), R = new T.WebGLRenderer({canvas: cv, antialias: true});
R.shadowMap.enabled = true; R.setPixelRatio(Math.min(devicePixelRatio, 2));
const sc = new T.Scene(); sc.background = new T.Color(0xbfe8ff);
const cam = new T.OrthographicCamera(-1, 1, 1, -1, .1, 100), focus = new T.Vector3();
let zoom = 7;
function fit() {
  const a = innerWidth / innerHeight; R.setSize(innerWidth, innerHeight, false);
  Object.assign(cam, {left: -zoom * a, right: zoom * a, top: zoom, bottom: -zoom}); cam.updateProjectionMatrix();
}
sc.add(new T.HemisphereLight(0xffffff, 0x88aa66, 1.1));
const L = new T.DirectionalLight(0xffffff, 1.6); L.position.set(6, 12, 4); L.castShadow = true;
L.shadow.mapSize.set(1024, 1024); Object.assign(L.shadow.camera, {left: -10, right: 10, top: 10, bottom: -10}); sc.add(L);

// toon material + thin outline (inverted hull)
function mk(g, col, o = 1.05) {
  const m = new T.Mesh(g, new T.MeshToonMaterial({color: col})); m.castShadow = m.receiveShadow = true;
  if (o) m.add(new T.Mesh(g, new T.MeshBasicMaterial({color: 0x2a2a2a, side: T.BackSide}))).children[0].scale.setScalar(o);
  return m;
}
const ground = mk(new T.BoxGeometry(16, .4, 16), 0x7ccf5b, 0); ground.position.y = -.2; sc.add(ground);

// plots
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
  g.add(soil); sc.add(g); return {g, soil, m: null, mc: -2};
});
function sync(i) {
  const p = plots[i], o = PL[i];
  o.soil.material.color.set(p.u ? 0x8b5a2b : 0x9aa0a6);
  if (o.mc !== p.c) {
    if (o.m) o.g.remove(o.m);
    o.m = p.c >= 0 ? cropMesh(p.c) : null;
    if (o.m) { o.m.position.y = .3; o.m.userData.pop = Date.now(); o.g.add(o.m); }
    o.mc = p.c;
  }
}

// decor: trees, market stall, hen
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

// farmer
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

// ---------- game actions ----------
function fly(txt, v) {
  const p = v.clone().project(cam), x = (p.x + 1) / 2 * innerWidth, y = (1 - p.y) / 2 * innerHeight, d = document.createElement('div');
  d.className = 'fly'; d.textContent = txt; d.style.left = x + 'px'; d.style.top = y + 'px'; document.body.appendChild(d);
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
  fly(`${c.e} +${fmt(a)} ${coin}`, PL[i].g.position.clone().setY(1));
  say(pick(S.sold).replace('{c}', coin).replace('{a}', fmt(a))); beep(780, .12);
}
function tap(i) {
  const p = plots[i];
  if (!p.u) {
    if (!can(LAND.coin, LAND.cost)) return say(S.locked(LAND.cost, LAND.coin));
    return go(stand(i), () => {
      if (!pay(LAND.coin, LAND.cost)) return say(S.poor(LAND.coin));
      p.u = true; PL[i].g.userData.pop = Date.now(); sync(i); beep(660); say(S.unlocked);
    });
  }
  if (p.c < 0) {
    const c = CROPS[seed]; if (!can(c.coin, c.cost)) return say(S.poor(c.coin));
    return go(stand(i), () => {
      if (p.c >= 0 || !pay(c.coin, c.cost)) return say(S.poor(c.coin));
      p.c = seed; p.t = Date.now(); sync(i); beep(440); say(S.planted);
    });
  }
  const left = Math.ceil((CROPS[p.c].t * 1e3 - (Date.now() - p.t)) / 1e3);
  if (left > 0) return say(S.grow(left));
  go(stand(i), () => harvest(i));
}

// ---------- UI ----------
$('bar').innerHTML = CROPS.map((c, i) => `<button data-i="${i}">${c.e}<b>${c.n}</b><small>$${c.cost} in ${c.coin}</small></button>`).join('');
const mark = () => [...$('bar').children].forEach((b, i) => b.classList.toggle('on', i == seed));
$('bar').onclick = e => { const b = e.target.closest('button'); if (b) { seed = +b.dataset.i; mark(); beep(500, .05); } };
mark();

const wp = $('wp'), opts = COINS.map(c => `<option>${c.s}</option>`).join('');
wp.innerHTML = `<div id="wl"></div><div id="sw"><b>Swap</b><select id="sf">${opts}</select>→<select id="st">${opts}</select><input id="sa" type="number" min="1" value="10" aria-label="Amount in USD"><button id="sb">Swap $</button><small>Gas fee: 1% (min $0.50)</small></div>`;
$('sf').value = 'USDT'; $('st').value = 'DOGE';
function renderW() {
  $('wl').innerHTML = COINS.map(c => {
    const d = px[c.s] - prev[c.s], up = d >= 0;
    return `<div class="r"><i style="background:${c.c}"></i><b>${c.s}</b><span>${fmt(bal[c.s])}</span><em>$${fmt(bal[c.s] * px[c.s])}</em><u class="${up ? 'up' : 'dn'}">${up ? '▲' : '▼'} $${fmt(px[c.s])}</u></div>`;
  }).join('');
}
const hud = () => $('wb').textContent = '💰 $' + COINS.reduce((s, c) => s + bal[c.s] * px[c.s], 0).toFixed(0);
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
$('go').onclick = () => { $('title').remove(); beep(520); };

// ---------- price simulation ----------
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
setInterval(save, 3000); addEventListener('beforeunload', save);

// ---------- input: tap, drag to pan, pinch / wheel to zoom ----------
const ray = new T.Raycaster(), pt = new Map(); let moved = 0;
const clampZ = () => { zoom = Math.min(11, Math.max(4, zoom)); fit(); };
cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); pt.set(e.pointerId, [e.clientX, e.clientY]); moved = 0; });
cv.addEventListener('pointermove', e => {
  const o = pt.get(e.pointerId); if (!o) return; const n = [e.clientX, e.clientY];
  if (pt.size == 2) {
    const [a, b] = [...pt.values()], d0 = Math.hypot(a[0] - b[0], a[1] - b[1]); pt.set(e.pointerId, n);
    const [a2, b2] = [...pt.values()], d1 = Math.hypot(a2[0] - b2[0], a2[1] - b2[1]);
    zoom *= d0 / d1; clampZ(); moved = 99; return;
  }
  const dx = n[0] - o[0], dy = n[1] - o[1]; moved += Math.abs(dx) + Math.abs(dy);
  if (moved > 8) {
    const u = 2 * zoom / innerHeight * .707;
    focus.x = Math.max(-4, Math.min(4, focus.x + (-dx - dy) * u)); focus.z = Math.max(-4, Math.min(4, focus.z + (dx - dy) * u));
  }
  pt.set(e.pointerId, n);
});
cv.addEventListener('pointerup', e => {
  pt.delete(e.pointerId);
  if (moved < 9 && !pt.size) {
    ray.setFromCamera(new T.Vector2(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), cam);
    const h = ray.intersectObjects(PL.map(o => o.soil), false)[0]; if (h) tap(h.object.userData.i);
  }
});
cv.addEventListener('pointercancel', e => pt.delete(e.pointerId));
cv.addEventListener('wheel', e => { zoom *= 1 + Math.sign(e.deltaY) * .08; clampZ(); }, {passive: true});
addEventListener('resize', fit);

// ---------- main loop ----------
let last = performance.now();
function loop(now) {
  const dt = Math.min(.05, (now - last) / 1000); last = now; const D = Date.now();
  PL.forEach((o, i) => {
    const p = plots[i], k = o.g.userData.pop ? Math.min(1, (D - o.g.userData.pop) / 450) : 1;
    o.g.scale.y = Math.max(.01, back(k));
    if (o.m) {
      const pr = Math.min(1, (D - p.t) / (CROPS[p.c].t * 1e3)), b = back(Math.min(1, (D - o.m.userData.pop) / 500)),
        gs = .25 + .75 * pr, w = 1 - (b - 1) * .6; let y = gs * b;
      if (pr >= 1) y *= 1 + .06 * Math.sin(D / 180);
      o.m.scale.set(gs * w, Math.max(.01, y), gs * w);
    }
  });
  // farmer: walk with bobbing, ease-turn, idle breathing
  const d = tgt ? tgt.clone().sub(F.position) : null; if (d) d.y = 0;
  if (d && d.length() > .08) {
    walk += dt * 10; const step = Math.min(3.6 * dt, d.length()), a = Math.atan2(d.x, d.z);
    F.position.addScaledVector(d.normalize(), step);
    F.rotation.y += (((a - F.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * Math.min(1, dt * 12);
    F.position.y = Math.abs(Math.sin(walk)) * .1; legs[0].rotation.x = Math.sin(walk) * .7; legs[1].rotation.x = -Math.sin(walk) * .7;
  } else {
    F.position.y *= .8; legs.forEach(l => l.rotation.x *= .8); fb.scale.y = 1 + .03 * Math.sin(D / 400);
    if (tgt) { const f = after; tgt = after = null; f && f(); }
  }
  // hen idle: hop + peck
  hen.position.y = .35 + Math.abs(Math.sin(D / 330)) * .03; hen.rotation.y = Math.sin(D / 1500) * .6;
  hh.rotation.x = Math.sin(D / 250) > .8 ? .6 : 0;
  cam.position.set(focus.x + 10, 10, focus.z + 10); cam.lookAt(focus);
  R.render(sc, cam); requestAnimationFrame(loop);
}
PL.forEach((_, i) => sync(i)); fit(); hud(); say(pick(S.news)); requestAnimationFrame(loop);
