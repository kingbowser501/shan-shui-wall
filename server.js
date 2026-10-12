// Wall server: serves the painting and the phone remote, and relays remote
// changes to the display live over Server-Sent Events. No dependencies.
//
//   node server.js            # http://<this-machine>:8080  (remote at /remote)
//   PORT=9000 node server.js

"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const PORT = Number(process.env.PORT || 8080);
const PUBLIC = path.join(__dirname, "public");
const STATE_FILE = path.join(__dirname, "data", "state.json");

const DEFAULTS = { seed: newSeed(), speed: 6, paused: false, brightness: 1, position: 0 };
const LIMITS = { speed: [0, 60], brightness: [0, 1] };

let state = { ...DEFAULTS, ...readJSON(STATE_FILE) };
const displays = new Set(); // SSE responses from painting pages
const remotes = new Set(); // SSE responses from remote pages

function newSeed() {
  return Math.random().toString(36).slice(2, 10);
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE + ".tmp", JSON.stringify(state, null, 2));
    fs.renameSync(STATE_FILE + ".tmp", STATE_FILE);
  }, 500);
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return "localhost";
}

function publicState() {
  return {
    ...state,
    displays: displays.size,
    remoteUrl: `http://${lanAddress()}:${PORT}/remote`,
  };
}

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event = "state") {
  const data = event === "state" ? publicState() : {};
  for (const res of [...displays, ...remotes]) send(res, event, data);
}

function update(patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (k === "paused") state.paused = Boolean(v);
    else if (k === "seed" && typeof v === "string" && v.trim()) {
      state.seed = v.trim().slice(0, 64);
      state.position = 0;
    } else if (k in LIMITS && Number.isFinite(Number(v))) {
      const [lo, hi] = LIMITS[k];
      state[k] = Math.min(hi, Math.max(lo, Number(v)));
    }
  }
  save();
  broadcast();
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1e4) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (rel === "/") rel = "/index.html";
  if (rel === "/remote") rel = "/remote.html";
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC + path.sep)) return res.writeHead(403).end();
  fs.readFile(file, (err, buf) => {
    if (err) return res.writeHead(404).end("not found");
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const set = url.searchParams.get("role") === "remote" ? remotes : displays;
    set.add(res);
    send(res, "state", publicState());
    if (set === displays) broadcast(); // remotes see the display come online
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => {
      clearInterval(ping);
      set.delete(res);
      if (set === displays) broadcast();
    });
    return;
  }
  if (route === "GET /api/state") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(publicState()));
  }
  if (route === "POST /api/state") {
    update(await readBody(req));
    return res.writeHead(204).end();
  }
  if (route === "POST /api/new") {
    update({ seed: newSeed() });
    return res.writeHead(204).end();
  }
  if (route === "POST /api/position") {
    const { seed, x } = await readBody(req);
    if (seed === state.seed && Number.isFinite(x)) {
      state.position = x;
      save();
    }
    return res.writeHead(204).end();
  }
  if (route === "POST /api/reload") {
    broadcast("reload");
    return res.writeHead(204).end();
  }
  if (req.method === "GET") return serveStatic(req, res);
  res.writeHead(405).end();
});

server.listen(PORT, () => {
  console.log(`Shan Shui wall running`);
  console.log(`  painting: http://localhost:${PORT}/`);
  console.log(`  remote:   http://${lanAddress()}:${PORT}/remote`);
});
