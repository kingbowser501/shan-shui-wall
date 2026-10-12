// Generates and paints landscape tiles off the main thread, so the page only
// ever has finished images to slide across the screen. That keeps the drift
// smooth even on phone-class chips like the ones in Android art frames.
//
// The upstream engine draws everything as SVG <polyline> strings. We generate
// the world in 512-unit chunks (as upstream does), parse every object into its
// individual strokes, and index each stroke by its horizontal extent. A tile
// is then painted on an OffscreenCanvas from only the strokes that cross it.
//
// Messages in:  {type:"init", seed, startX, tileW, viewH, pxW, pxH}
//               {type:"tile", index}
//               {type:"forget", beforeX}
// Messages out: {type:"tile", index, bitmap, genMs, drawMs}  (bitmap is transferred)

self.window = self;
self.document = { addEventListener() {}, getElementById() { return null; } };
console.log = () => {}; // the engine is chatty
importScripts("engine.js");

const CHUNK = 512; // upstream MEM.cwid
// Objects can sit up to ~1000 units left of the chunk that spawned them, so a
// tile is only final once the world is generated this far past its right edge.
const LOOKAHEAD = 3 * CHUNK;
const PAD = 12; // stroke widths reach a little past their points

let seed = "";
let tileW = 512;
let viewH = 700;
let pxW = 512; // tile size in device pixels
let pxH = 700;
let paper = null; // CanvasPattern
let paperSize = 512;
let ink = null; // scratch layer: strokes composite normally here, then multiply onto paper
let genX = 0; // world is generated up to here
let items = []; // {y, seq, minX, maxX, pieces: see parse()}
let seq = 0;

function init(msg) {
  seed = String(msg.seed);
  tileW = msg.tileW;
  viewH = msg.viewH;
  pxW = msg.pxW;
  pxH = msg.pxH;
  Math.seed(seed);
  Noise.noise(0); // fixes the Perlin table for this seed before per-chunk reseeding
  paper = makePaper();
  ink = new OffscreenCanvas(pxW, pxH);
  MEM.planmtx = [];
  items = [];
  seq = 0;
  genX = Math.floor(msg.startX / CHUNK) * CHUNK - LOOKAHEAD;
}

// A warm, mottled paper tile, mirrored so it repeats seamlessly (as upstream).
function makePaper() {
  const reso = paperSize;
  const c = new OffscreenCanvas(reso, reso);
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(reso, reso);
  for (let i = 0; i <= reso / 2; i++) {
    for (let j = 0; j <= reso / 2; j++) {
      const v = 245 + Noise.noise(i * 0.1, j * 0.1) * 10 - Math.random() * 20;
      for (const [x, y] of [[i, j], [reso - i, j], [i, reso - j], [reso - i, reso - j]]) {
        if (x >= reso || y >= reso) continue;
        const k = (y * reso + x) * 4;
        img.data[k] = v;
        img.data[k + 1] = v * 0.95;
        img.data[k + 2] = v * 0.85;
        img.data[k + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return ctx.createPattern(c, "repeat");
}

const clear = (c) => /^rgba\([^)]*,\s*0(\.0*)?\)$/.test(c) || c === "none";

// Parses one object's SVG into strokes: {pts, fill, stroke, width, minX, maxX}
// or a pavilion label: {text, size, color, x, y, rot, minX, maxX}.
function parse(canv) {
  const out = [];
  for (const m of canv.matchAll(/<polyline points='([^']*)' style='fill:([^;]*);stroke:([^;]*);stroke-width:([^']*)'\/>/g)) {
    const nums = m[1].trim().split(/[\s,]+/).map(Number);
    if (nums.length < 4) continue;
    const pts = new Float32Array(nums);
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      if (pts[i] < minX) minX = pts[i];
      if (pts[i] > maxX) maxX = pts[i];
    }
    const width = parseFloat(m[4]) || 0;
    const fill = clear(m[2]) ? null : m[2];
    const stroke = width > 0 && !clear(m[3]) ? m[3] : null;
    if (!fill && !stroke) continue;
    out.push({ pts, fill, stroke, width, minX: minX - PAD, maxX: maxX + PAD });
  }
  for (const m of canv.matchAll(/<text font-size='([\d.]+)'[^>]*fill:([^']*)'[^>]*translate\(([-\d.e]+),([-\d.e]+)\) rotate\(([-\d.e]+)\)'>([\s\S]*?)<\/text>/g)) {
    const x = parseFloat(m[3]);
    out.push({
      text: m[6],
      size: parseFloat(m[1]),
      color: m[2],
      x,
      y: parseFloat(m[4]),
      rot: (parseFloat(m[5]) * Math.PI) / 180,
      minX: x - 150,
      maxX: x + 150,
    });
  }
  return out;
}

function addItem(y, canv) {
  if (canv.includes("NaN")) canv = canv.replace(/NaN/g, -1000); // as upstream does
  const pieces = parse(canv);
  if (!pieces.length) return;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const p of pieces) {
    if (p.minX < minX) minX = p.minX;
    if (p.maxX > maxX) maxX = p.maxX;
  }
  items.push({ y, seq: seq++, minX, maxX, pieces });
}

// Mirrors upstream chunkloader(), but reseeds per chunk so the painting can
// resume from any position without replaying everything before it.
function generateChunk(x0) {
  Math.seed(seed + "@" + x0);
  const plan = mountplanner(x0, x0 + CHUNK);
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    if (p.tag === "mount") {
      addItem(p.y, Mount.mountain(p.x, p.y, i * 2 * Math.random()));
      addItem(p.y - 10000, water(p.x, p.y, i * 2));
    } else if (p.tag === "flatmount") {
      addItem(
        p.y,
        Mount.flatMount(p.x, p.y, 2 * Math.random() * Math.PI, {
          wid: 600 + Math.random() * 400,
          hei: 100,
          cho: 0.5 + Math.random() * 0.2,
        }),
      );
    } else if (p.tag === "distmount") {
      addItem(
        p.y,
        Mount.distMount(p.x, p.y, Math.random() * 100, {
          hei: 150,
          len: randChoice([500, 1000, 1500]),
        }),
      );
    } else if (p.tag === "boat") {
      addItem(
        p.y,
        Arch.boat01(p.x, p.y, Math.random(), {
          sca: p.y / 800,
          fli: randChoice([true, false]),
        }),
      );
    }
  }
}

function renderTile(index) {
  const t0 = performance.now();
  const x0 = index * tileW;
  const x1 = x0 + tileW;
  while (genX < x1 + LOOKAHEAD) {
    generateChunk(genX);
    genX += CHUNK;
  }
  const t1 = performance.now();

  const ictx = ink.getContext("2d");
  ictx.setTransform(1, 0, 0, 1, 0, 0);
  ictx.clearRect(0, 0, pxW, pxH);
  ictx.setTransform(pxW / tileW, 0, 0, pxH / viewH, (-x0 * pxW) / tileW, 0);
  const hit = items
    .filter((it) => it.maxX > x0 && it.minX < x1)
    .sort((a, b) => a.y - b.y || a.seq - b.seq); // upstream paints back-to-front by y
  for (const it of hit) {
    for (const p of it.pieces) {
      if (p.maxX <= x0 || p.minX >= x1) continue;
      if (p.text !== undefined) {
        ictx.save();
        ictx.translate(p.x, p.y);
        ictx.rotate(p.rot);
        ictx.font = `${p.size}px Verdana, sans-serif`;
        ictx.textAlign = "center";
        ictx.fillStyle = p.color;
        ictx.fillText(p.text, 0, 0);
        ictx.restore();
        continue;
      }
      const pts = p.pts;
      ictx.beginPath();
      ictx.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) ictx.lineTo(pts[i], pts[i + 1]);
      if (p.fill) {
        ictx.fillStyle = p.fill;
        ictx.fill();
      }
      if (p.stroke) {
        ictx.strokeStyle = p.stroke;
        ictx.lineWidth = p.width;
        ictx.stroke();
      }
    }
  }

  // Paper first, then the ink layer multiplied over it, as upstream blends its SVG.
  const tile = new OffscreenCanvas(pxW, pxH);
  const ctx = tile.getContext("2d");
  const shift = (((index * pxW) % paperSize) + paperSize) % paperSize;
  paper.setTransform(new DOMMatrix([1, 0, 0, 1, -shift, 0]));
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, pxW, pxH);
  ctx.globalCompositeOperation = "multiply";
  ctx.drawImage(ink, 0, 0);
  const bitmap = tile.transferToImageBitmap();
  const t2 = performance.now();
  return { bitmap, genMs: Math.round(t1 - t0), drawMs: Math.round(t2 - t1) };
}

function forget(beforeX) {
  items = items.filter((it) => it.maxX >= beforeX);
  const k = Math.floor((beforeX - LOOKAHEAD) / 5); // planmtx is indexed by x/5
  for (const key in MEM.planmtx) if (+key < k) delete MEM.planmtx[key];
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "init") init(msg);
  else if (msg.type === "tile") {
    const { bitmap, genMs, drawMs } = renderTile(msg.index);
    self.postMessage({ type: "tile", index: msg.index, bitmap, genMs, drawMs }, [bitmap]);
  } else if (msg.type === "forget") forget(msg.beforeX);
};
