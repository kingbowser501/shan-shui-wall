// The living painting: an endless, slowly drifting Shan Shui landscape.
//
// worker.js generates and paints tiles off the main thread and hands over
// finished bitmaps. They sit side by side in one "strip" moved with a GPU
// transform, so the per-frame cost is just compositing. A new seed
// crossfades in a second strip.
//
// Settings come from the wall server (/api/state, live over /api/events).
// Without a server the page still runs, configured by URL parameters:
//   ?seed=abc&speed=6&brightness=1&res=0.75
// Add ?test to show a performance overlay for checking new hardware.

"use strict";

const VIEW_H = 700; // world units visible vertically (upstream: 800 / 1.142)
const TILE_W = 512; // world units per tile
const AHEAD = 2; // tiles prepared beyond the right edge of the screen

const params = new URLSearchParams(location.search);
const settings = {
  seed: params.get("seed") || String(Date.now()),
  speed: Number(params.get("speed") || 6), // world units per second
  paused: params.get("paused") === "1",
  brightness: Number(params.get("brightness") || 1),
  position: Number(params.get("x") || 0),
};
let serverMode = false;

const stage = document.getElementById("stage");
const dim = document.getElementById("dim");
const hint = document.getElementById("hint");
const statsEl = document.getElementById("stats");

// ---------------------------------------------------------------- geometry

const RES = Math.min(1, Number(params.get("res") || 1)); // render scale, <1 for slow hardware
let tilePx, sx, viewW, pxW, pxH; // tile css px, css px per world unit, view width (world), tile device px
function measure() {
  tilePx = Math.round(TILE_W * (innerHeight / VIEW_H));
  sx = tilePx / TILE_W;
  viewW = innerWidth / sx;
  const k = Math.min(devicePixelRatio || 1, 2160 / innerHeight) * RES;
  pxH = Math.round(innerHeight * k);
  pxW = Math.round(tilePx * k);
}
measure();

// ---------------------------------------------------------------- scene

class Scene {
  constructor(seed, startX) {
    this.seed = seed;
    this.x = startX; // world position of the screen's left edge
    this.shown = false;
    this.tiles = new Map(); // index -> <canvas> once ready, null while pending
    this.origin = Math.floor(startX / TILE_W) - 1; // strip-local tile 0
    this.inflight = 0;
    this.dead = false;

    this.el = document.createElement("div");
    this.el.className = "strip";
    this.el.style.opacity = "0";
    stage.appendChild(this.el);

    this.worker = new Worker("worker.js");
    this.worker.onmessage = (e) => this.onTile(e.data);
    this.worker.postMessage({ type: "init", seed, startX, tileW: TILE_W, viewH: VIEW_H, pxW, pxH });
  }

  range(x) {
    return [Math.floor(x / TILE_W), Math.floor((x + viewW) / TILE_W)];
  }

  // True once every tile the screen needs at world position x is on screen.
  covers(x) {
    const [a, b] = this.range(x);
    for (let i = a; i <= b; i++) if (!this.tiles.get(i)) return false;
    return true;
  }

  request(x) {
    const [a, b] = this.range(x);
    for (let i = a; i <= b + AHEAD && this.inflight < 2; i++) {
      if (this.tiles.has(i)) continue;
      this.tiles.set(i, null);
      this.inflight++;
      this.worker.postMessage({ type: "tile", index: i });
    }
    // Drop tiles that have scrolled off the left edge.
    for (const [i, t] of this.tiles) {
      if (i < a - 1 && t) {
        t.remove();
        t.width = 0; // release the pixels now rather than at GC
        this.tiles.delete(i);
        this.worker.postMessage({ type: "forget", beforeX: (a - 1) * TILE_W });
      }
    }
    if (a - 1 - this.origin > 32) this.rebase(a - 1);
  }

  onTile({ index, bitmap, genMs, drawMs }) {
    this.inflight--;
    if (this.dead) return bitmap.close();
    const t0 = performance.now();
    const c = document.createElement("canvas");
    c.width = bitmap.width;
    c.height = bitmap.height;
    c.getContext("bitmaprenderer").transferFromImageBitmap(bitmap); // zero-copy hand-off
    c.style.width = tilePx + "px";
    c.style.left = (index - this.origin) * tilePx + "px";
    this.el.appendChild(c);
    this.tiles.set(index, c);
    stats.tile(genMs, drawMs, performance.now() - t0);
  }

  // Keep strip-local coordinates small so they never lose precision.
  rebase(origin) {
    this.origin = origin;
    for (const [i, t] of this.tiles) if (t) t.style.left = (i - origin) * tilePx + "px";
  }

  show() {
    this.shown = true;
    this.el.style.opacity = "1";
  }

  place() {
    const px = (this.origin * TILE_W - this.x) * sx;
    this.el.style.transform = `translate3d(${px.toFixed(2)}px,0,0)`;
  }

  destroy() {
    this.dead = true;
    this.worker.terminate();
    for (const t of this.tiles.values()) if (t) t.width = 0;
    this.el.remove();
  }
}

// ---------------------------------------------------------------- animation

let current = null; // the scene on screen
let incoming = null; // a new landscape fading in over it
const leaving = []; // old scenes fading out
let last = performance.now();

function frame(now) {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  const dx = settings.paused ? 0 : settings.speed * dt;

  current.request(current.x);
  if (incoming) incoming.request(incoming.x);

  // Only drift once the landscape is drawn ahead of us; never scroll into blank paper.
  const ready = current.covers(current.x + dx);
  if (dx && ready) {
    for (const s of [current, incoming, ...leaving]) if (s) s.x += dx;
  }
  stats.frame(now, dt, current.shown && dx > 0 && !ready);
  for (const s of [current, incoming, ...leaving]) if (s) s.place();

  if (!current.shown && current.covers(current.x)) current.show();
  if (incoming && incoming.covers(incoming.x)) {
    incoming.show();
    const old = current;
    current = incoming;
    incoming = null;
    old.el.style.opacity = "0";
    leaving.push(old);
    setTimeout(() => {
      leaving.splice(leaving.indexOf(old), 1);
      old.destroy();
    }, 6500);
  }
  requestAnimationFrame(frame);
}

function start(seed, x) {
  current = new Scene(seed, x);
  requestAnimationFrame(frame);
}

function newScene(seed, x) {
  if (incoming) incoming.destroy();
  incoming = new Scene(seed, x); // appended last, so it sits on top
}

addEventListener("resize", () => {
  measure();
  if (current) newScene(current.seed, current.x);
});

// ---------------------------------------------------------------- settings

function apply(s) {
  if (s.seed !== undefined && s.seed !== settings.seed) {
    settings.seed = s.seed;
    if (current) newScene(s.seed, s.position || 0);
  }
  for (const k of ["speed", "paused", "brightness", "position"]) if (s[k] !== undefined) settings[k] = s[k];
  const b = Math.max(0, Math.min(1, settings.brightness));
  if (window.ShanShuiFrame) {
    // In the frame app: dim the real backlight rather than darkening the picture.
    window.ShanShuiFrame.setBrightness(b);
    dim.style.opacity = "0";
  } else {
    dim.style.opacity = String(1 - b);
  }
}

function startStandalone() {
  if (!current) start(settings.seed, settings.position);
}

function connect() {
  const es = new EventSource("api/events");
  es.addEventListener("state", (e) => {
    const s = JSON.parse(e.data);
    apply(s);
    if (!serverMode) {
      serverMode = true;
      start(settings.seed, settings.position); // resume where the painting left off
      if (s.remoteUrl) showHint(`Remote: ${s.remoteUrl}`);
    }
  });
  es.addEventListener("reload", () => location.reload());
  es.onerror = () => {
    if (!serverMode) {
      es.close(); // no wall server: run on URL parameters
      startStandalone();
    }
  };
  setTimeout(() => !serverMode && (es.close(), startStandalone()), 3000);
}
apply({});
if (location.protocol.startsWith("http") && !params.has("standalone")) connect();
else startStandalone();

// Report our position so a restart resumes in the same place.
setInterval(() => {
  if (!serverMode || !current) return;
  fetch("api/position", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ seed: current.seed, x: Math.round(current.x) }),
  }).catch(() => {});
}, 20000);

function showHint(text) {
  hint.textContent = text;
  hint.style.opacity = "1";
  setTimeout(() => (hint.style.opacity = "0"), 20000);
}

// ---------------------------------------------------------------- test overlay

// ?test shows live numbers for judging new hardware: frame pacing, how long
// tiles take to generate and paint, and whether the drift ever had to wait.
const stats = {
  on: params.has("test"),
  t0: performance.now(),
  dts: [], // frame times (ms), last ~10 s
  tiles: [], // {gen, draw, insert}
  stalls: 0,
  stallMs: 0,
  stalled: false,

  frame(now, dt, waiting) {
    if (!this.on) return;
    this.dts.push(dt * 1000);
    if (this.dts.length > 600) this.dts.shift();
    if (waiting) {
      if (!this.stalled) this.stalls++;
      this.stallMs += dt * 1000;
    }
    this.stalled = waiting;
  },

  tile(gen, draw, insert) {
    if (!this.on) return;
    this.tiles.push({ gen, draw, insert });
    if (this.tiles.length > 50) this.tiles.shift();
  },

  render() {
    const d = [...this.dts].sort((a, b) => a - b);
    const n = d.length || 1;
    const avg = d.reduce((a, b) => a + b, 0) / n;
    const fps = avg ? 1000 / avg : 0;
    const p99 = d[Math.floor(n * 0.99)] || 0;
    const janky = d.filter((x) => x > 50).length;
    const t = this.tiles;
    const mean = (k) => (t.length ? Math.round(t.reduce((a, x) => a + x[k], 0) / t.length) : 0);
    const max = (k) => (t.length ? Math.round(Math.max(...t.map((x) => x[k]))) : 0);
    const last = t[t.length - 1];
    const up = Math.round((performance.now() - this.t0) / 1000);
    const secs = TILE_W / Math.max(settings.speed, 0.01);
    const lines = [
      `SHAN SHUI TEST  ·  up ${Math.floor(up / 60)}m ${up % 60}s  ·  seed ${settings.seed}`,
      `screen ${innerWidth}×${innerHeight} css @${devicePixelRatio}x  ·  tiles ${pxW}×${pxH} px  ·  res ${RES}`,
      `fps ${fps.toFixed(1)}  ·  p99 frame ${p99.toFixed(0)} ms  ·  janky (>50ms) ${janky}/${d.length}`,
      `tiles ${t.length}  ·  last gen ${last ? last.gen : "-"} / paint ${last ? last.draw : "-"} ms`,
      `avg gen ${mean("gen")} / paint ${mean("draw")} / insert ${mean("insert")} ms  ·  max gen ${max("gen")} / paint ${max("draw")}`,
      `budget: a new tile every ${secs.toFixed(0)} s at speed ${settings.speed}`,
      `waited for tiles ${this.stalls}×, ${(this.stallMs / 1000).toFixed(1)} s total`,
      `cores ${navigator.hardwareConcurrency || "?"}  ·  memory ${navigator.deviceMemory || "?"} GB`,
      navigator.userAgent,
    ];
    if (current && !current.shown) lines.splice(1, 0, `preparing first tiles… ${current.tiles.size ? [...current.tiles.values()].filter(Boolean).length : 0} ready`);
    statsEl.textContent = lines.join("\n");
  },
};
if (stats.on) {
  statsEl.hidden = false;
  document.body.style.cursor = "default";
  setInterval(() => stats.render(), 500);
}

// Keep the screen awake where the browser allows it.
async function stayAwake() {
  try {
    await navigator.wakeLock?.request("screen");
  } catch {}
}
stayAwake();
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && stayAwake());
