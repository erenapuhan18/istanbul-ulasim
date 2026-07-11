/* İstanbul Canlı Ulaşım — harita + tarife tabanlı araç tahmini
   Veri: data.js (İBB Açık Veri + Metro İstanbul API'den derlendi)
   Canlı: sefer saatleri + hat durumu tarayıcıdan Metro İstanbul API'sinden çekilir. */
(() => {
"use strict";

const D = window.TRANSIT;
const API_V2 = D.api;
const API_V1 = API_V2.replace("/V2", "");

// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
const norm = (s) => (s || "").toLocaleUpperCase("tr")
  .replace(/İ/g, "I").replace(/Ş/g, "S").replace(/Ğ/g, "G")
  .replace(/Ü/g, "U").replace(/Ö/g, "O").replace(/Ç/g, "C")
  .replace(/[^A-Z0-9]/g, "");
const hmToMin = (hm) => {
  if (!hm) return null;
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + (m || 0);
};
const pad = (n) => String(n).padStart(2, "0");
const fmtHM = (epochMin) => {
  const d = new Date(epochMin * 60000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const nowEpochMin = () => Date.now() / 60000;
const localISO = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const midnightEpochMin = (d) => {
  const m = new Date(d); m.setHours(0, 0, 0, 0);
  return m.getTime() / 60000;
};
const distM = (a, b) => {
  const R = 6371000, dLat = (b[0] - a[0]) * Math.PI / 180, dLng = (b[1] - a[1]) * Math.PI / 180;
  const la = a[0] * Math.PI / 180, lb = b[0] * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const cumMeters = (pts) => {
  const c = [0];
  for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + distM(pts[i - 1], pts[i]));
  return c;
};
const pointAtMeters = (pts, cum, m) => {
  if (m <= 0) return pts[0];
  const total = cum[cum.length - 1];
  if (m >= total) return pts[pts.length - 1];
  let lo = 0, hi = cum.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= m) lo = mid; else hi = mid; }
  const f = (m - cum[lo]) / (cum[lo + 1] - cum[lo] || 1);
  return [pts[lo][0] + f * (pts[lo + 1][0] - pts[lo][0]), pts[lo][1] + f * (pts[lo + 1][1] - pts[lo][1])];
};
const fmtKm = (km) => km >= 10 ? `${km.toFixed(1).replace(".", ",")} km` : `${km.toFixed(1).replace(".", ",")} km`;

const KIND_LABEL = { metro: "Metro", tramvay: "Tramvay", funikuler: "Füniküler", teleferik: "Teleferik", marmaray: "Marmaray", metrobus: "Metrobüs", vapur: "Vapur" };

// ---------- unified line model ----------
const lines = [];

for (const L of D.lines) {
  const dirs = (L.directions || []).filter((d) => d.stops && d.stops.length > 1).map((d) => ({
    id: d.id,
    name: d.name,
    stops: d.stops,
    dur: d.stops[d.stops.length - 1].min,
    origin: d.stops[0].id,
    destName: d.stops[d.stops.length - 1].name,
  }));
  lines.push({
    key: L.key, kind: L.kind, color: L.color, desc: L.desc,
    first: L.firstTime, last: L.lastTime,
    year: L.year, story: L.story,
    stations: L.stations, dirs, live: true,
  });
}

function staticLine(S, kind) {
  const path = S.path;
  const cum = cumMeters(path);
  const total = cum[cum.length - 1];
  const sts = (S.stations || []).map((s) => ({ ...s, meters: (s.cumMin / S.durationMin) * total }));
  const mk = (rev) => {
    const dest = rev
      ? (sts[0] ? sts[0].name : "dönüş")
      : (sts[sts.length - 1] ? sts[sts.length - 1].name : "gidiş");
    return {
      id: `${S.key}:${rev ? "R" : "F"}`,
      name: `${dest} yönü`, destName: dest,
      dur: S.durationMin, rev, synthetic: true,
    };
  };
  return {
    key: S.key, kind, color: S.color, desc: S.desc || S.name, name: S.name,
    first: S.firstTime || "06:00", last: S.lastTime || "00:00",
    year: S.year, story: S.story,
    stations: sts, path, cum, total,
    headways: (S.headways && S.headways.length) ? S.headways : [{ from: "07:00", to: "21:00", secs: 2400 }],
    dirs: [mk(false), mk(true)],
    live: false, schematic: !!S.schematic,
  };
}

if (D.marmaray) lines.push(staticLine(D.marmaray, "marmaray"));
for (const S of D.statics || []) lines.push(staticLine(S, S.kind === "metrobus" ? "metrobus" : S.kind));
const ferries = (D.ferries || []).map((F) => staticLine({ ...F, stations: [], durationMin: F.durationMin }, "vapur"));
for (const f of ferries) { f.desc = f.name; f.year = 1851; lines.push(f); }

const lineByKey = Object.fromEntries(lines.map((l) => [l.key, l]));

// ---------- station groups (transfer-aware) ----------
const groups = [];
for (const L of lines) {
  if (L.kind === "vapur" || !L.stations) continue;
  for (const st of L.stations) {
    const key = norm(st.name);
    let g = groups.find((x) => x.key === key && distM([x.lat, x.lng], [st.lat, st.lng]) < 450);
    if (!g) { g = { key, display: st.name, lat: st.lat, lng: st.lng, members: [] }; groups.push(g); }
    g.members.push({ line: L, st });
    st._g = g;
  }
}
// yön duraklarını istasyon nesnelerine bağla (şematik konum için)
for (const L of lines) {
  if (!L.live) continue;
  const byId = new Map(L.stations.map((s) => [s.id, s]));
  const byName = new Map(L.stations.map((s) => [norm(s.name), s]));
  for (const dir of L.dirs) for (const e of dir.stops) e._st = byId.get(e.id) || byName.get(norm(e.name)) || null;
}
const gPos = (g) => (schematic && g.slat != null) ? [g.slat, g.slng] : [g.lat, g.lng];
const gLineCount = (g) => new Set(g.members.map((m) => m.line.key)).size;

// ---------- map ----------
const map = L.map("map", { zoomControl: false, attributionControl: true, maxZoom: 17, minZoom: 9 })
  .setView([41.035, 29.0], 11);
L.control.zoom({ position: "bottomright" }).addTo(map);
map.attributionControl.setPrefix(false);
L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
  subdomains: "abcd", maxZoom: 19,
}).addTo(map);
const canvas = L.canvas({ padding: 0.4 });

// ---------- draw lines + stations ----------
const lineLayers = {};   // key -> [{layer, under, chain|null, geoPts}]
const stationMarkers = []; // {marker, line, group, member, dupIdx}

function drawChains(L) {
  // canlı hat: yön yollarını tekrarsız birleştir (ters yön atlanır, branşman çizilir)
  const chains = [];
  const drawn = new Set();
  for (const d of [...L.dirs].sort((a, b) => b.stops.length - a.stops.length)) {
    const news = d.stops.filter((s) => !drawn.has(s.id));
    if (!news.length) continue;
    chains.push(d.stops);
    d.stops.forEach((s) => drawn.add(s.id));
  }
  return chains;
}

function drawAll() {
  for (const L of lines) {
    const recs = [];
    const isFerry = L.kind === "vapur";
    const dash = isFerry ? "2 9" : L.schematic ? "7 7" : null;
    const weight = L.kind === "marmaray" ? 4.2 : isFerry ? 2 : L.kind === "metro" ? 3.6 : 3;
    const push = (geoPts, chain) => {
      recs.push({ layer: L2poly(geoPts, { color: "#05070c", weight: weight + 3, opacity: 0.55 }), under: true, chain, geoPts, w: weight + 3 });
      recs.push({ layer: L2poly(geoPts, { color: L.color, weight, opacity: isFerry ? 0.7 : 0.92, dashArray: dash }), under: false, chain, geoPts, w: weight });
    };
    let km = 0;
    if (L.path) {
      push(L.path, L.stations.length > 1 ? L.stations : null);
      km = L.total / 1000;
    } else {
      for (const chain of drawChains(L)) {
        const pts = chain.map((s) => [s.lat, s.lng]);
        push(pts, chain);
        km += cumMeters(pts).pop() / 1000;
      }
    }
    L.km = km;
    lineLayers[L.key] = recs;
  }
  for (const g of groups) {
    g.members.forEach((m, i) => {
      const mk = L.circleMarker([m.st.lat, m.st.lng], {
        renderer: canvas, radius: 3, color: m.line.color, weight: 2,
        fillColor: "#0b0f17", fillOpacity: 1, opacity: 1,
      }).addTo(map);
      mk.bindTooltip(tipHTML(g), { className: "st-tip", direction: "top", offset: [0, -6], sticky: true });
      mk.on("click", () => openBoard(g));
      stationMarkers.push({ marker: mk, line: m.line, group: g, member: m, dupIdx: i });
    });
  }
  scaleStations();
}
function L2poly(pts, opts) {
  return L.polyline(pts, { renderer: canvas, interactive: false, ...opts }).addTo(map);
}
function tipHTML(g) {
  const seen = new Set();
  const badges = g.members
    .filter((m) => (seen.has(m.line.key) ? false : seen.add(m.line.key)))
    .map((m) => `<span class="tip-badge" style="background:${m.line.color}">${m.line.key}</span>`)
    .join("");
  return `<span class="tip-lines">${badges}</span>${g.display}`;
}
function scaleStations() {
  const z = map.getZoom();
  let r = z >= 14 ? 4.5 : z >= 12.5 ? 3.5 : z >= 11.5 ? 2.6 : 2;
  if (schematic) r += 0.8; // diyagramda duraklar daha okunur olsun
  const zoomShow = z >= 10.5 || schematic;
  for (const s of stationMarkers) {
    const inter = schematic && gLineCount(s.group) > 1;
    const hideDup = schematic && s.dupIdx > 0; // şematikte grup tek nokta: kopyaları gizle
    const on = zoomShow && s.on !== false && !hideDup;
    s.marker.setRadius(inter ? r + 1.6 : r);
    s.marker.setStyle({
      opacity: on ? 1 : 0, fillOpacity: on ? 1 : 0,
      color: inter ? "#e8edf5" : s.line.color,
      fillColor: inter ? "#ffffff" : "#0b0f17",
    });
  }
}
map.on("zoomend", scaleStations);

// ---------- timetable cache (API lines) ----------
const tt = {};
const fetchQueue = [];
let queueTimer = null;

function unwrap(j) { return j && j.Data !== undefined ? j.Data : j; }
async function apiTimeTable(stationId, dirId, when) {
  const body = JSON.stringify({ boardingStationId: stationId, directionId: dirId, dateTime: localISO(when) });
  const opts = { method: "POST", headers: { "Content-Type": "application/json" }, body };
  for (const base of [API_V2, API_V1]) {
    try {
      const r = await fetch(`${base}/GetTimeTable`, opts);
      if (!r.ok) continue;
      const j = await r.json();
      if (j && j.Success === false) continue;
      const data = unwrap(j);
      const row = Array.isArray(data) ? data[0] : null;
      return row && row.TimeInfos && row.TimeInfos.Times ? row.TimeInfos.Times : [];
    } catch (e) { /* sıradaki taban */ }
  }
  return null;
}
function timesToEpoch(times, reqDate) {
  const base = midnightEpochMin(reqDate);
  const reqMin = reqDate.getHours() * 60 + reqDate.getMinutes();
  return times.map((t) => {
    let m = hmToMin(t);
    if (m == null) return null;
    if (m < reqMin - 90) m += 1440;
    return base + m;
  }).filter((x) => x != null);
}
function enqueueDir(L, dir, urgent) {
  const st = tt[dir.id];
  if (st && st.pending) return;
  if (st && st.failAt && Date.now() - st.failAt < 90000) return;
  tt[dir.id] = { ...(st || { times: [] }), pending: true };
  fetchQueue[urgent ? "unshift" : "push"](async () => {
    const start = new Date(Date.now() - (dir.dur + 4) * 60000);
    let all = [];
    let cursor = start;
    for (let i = 0; i < 4; i++) {
      const raw = await apiTimeTable(dir.origin, dir.id, cursor);
      if (raw === null) { tt[dir.id] = { times: all, at: Date.now(), failAt: Date.now() }; return; }
      if (!raw.length) break;
      const ep = timesToEpoch(raw, cursor);
      all = [...new Set([...all, ...ep])].sort((a, b) => a - b);
      const last = all[all.length - 1];
      if (last > nowEpochMin() + 25) break;
      cursor = new Date((last + 1) * 60000);
    }
    tt[dir.id] = { times: all, at: Date.now() };
  });
  pumpQueue();
}
function pumpQueue() {
  if (queueTimer) return;
  queueTimer = setInterval(async () => {
    const job = fetchQueue.shift();
    if (!job) { clearInterval(queueTimer); queueTimer = null; return; }
    try { await job(); } catch (e) { /* yut */ }
  }, 160);
}
function ensureTimes(L, dir) {
  const st = tt[dir.id];
  if (!st) { enqueueDir(L, dir); return null; }
  if (!st.pending && st.at) {
    const maxT = st.times.length ? st.times[st.times.length - 1] : 0;
    const stale = Date.now() - st.at > 10 * 60000 || (maxT < nowEpochMin() + 12 && Date.now() - st.at > 60000);
    if (stale) enqueueDir(L, dir);
  }
  return st.times || null;
}

// ---------- synthetic departures for static lines ----------
function syntheticDeps(L, horizonPastMin) {
  const deps = [];
  const today0 = midnightEpochMin(new Date());
  for (const dayOff of [-1, 0]) {
    const base = today0 + dayOff * 1440;
    for (const h of L.headways) {
      const from = hmToMin(h.from);
      let to = hmToMin(h.to);
      if (h.to === "00:00" || h.to === "24:00") to = 1440;
      for (let t = from; t < to; t += h.secs / 60) deps.push(base + t);
    }
  }
  const now = nowEpochMin();
  return deps.filter((d) => d > now - horizonPastMin && d < now + 40).sort((a, b) => a - b);
}

// ---------- vehicles ----------
const vehLayer = {};
const hiddenKinds = new Set();
let focusKey = null;
let vehCount = 0;
let schematic = false;
let morphing = false;
let growthYear = null;

function lineVisible(L) {
  if (hiddenKinds.has(L.kind)) return false;
  if (focusKey && L.key !== focusKey) return false;
  if (growthYear && (L.year || 0) > growthYear) return false;
  if (schematic && L.kind === "vapur") return false;
  return true;
}
const stopPos = (e) => (schematic && e._st && e._st._g && e._st._g.slat != null)
  ? [e._st._g.slat, e._st._g.slng] : [e.lat, e.lng];
const stStopPos = (s) => (schematic && s._g && s._g.slat != null) ? [s._g.slat, s._g.slng] : [s.lat, s.lng];

function posOnDir(L, dir, elapsed) {
  if (L.path) {
    if (schematic && L.stations.length > 1) {
      // şematikte istasyon zinciri üzerinde cumMin ile ilerle
      const sts = dir.rev ? [...L.stations].reverse() : L.stations;
      const t = (i) => dir.rev ? (dir.dur - sts[i].cumMin) : sts[i].cumMin;
      let i = 0;
      while (i < sts.length - 2 && t(i + 1) <= elapsed) i++;
      const a = sts[i], b = sts[i + 1];
      const span = (t(i + 1) - t(i)) || 1;
      const f = Math.min(1, Math.max(0, (elapsed - t(i)) / span));
      const pa = stStopPos(a), pb = stStopPos(b);
      return [pa[0] + f * (pb[0] - pa[0]), pa[1] + f * (pb[1] - pa[1])];
    }
    const frac = Math.min(1, Math.max(0, elapsed / dir.dur));
    const m = dir.rev ? L.total * (1 - frac) : L.total * frac;
    return pointAtMeters(L.path, L.cum, m);
  }
  const st = dir.stops;
  let i = 0;
  while (i < st.length - 2 && st[i + 1].min <= elapsed) i++;
  const a = st[i], b = st[i + 1];
  const span = (b.min - a.min) || 1;
  const f = Math.min(1, Math.max(0, (elapsed - a.min) / span));
  const pa = stopPos(a), pb = stopPos(b);
  return [pa[0] + f * (pb[0] - pa[0]), pa[1] + f * (pb[1] - pa[1])];
}
function nextStopName(dir, elapsed) {
  if (!dir.stops) return dir.destName;
  for (const s of dir.stops) if (s.min > elapsed) return s.name;
  return dir.destName;
}

function tick() {
  if (morphing) return;
  const now = nowEpochMin();
  const active = new Set();
  vehCount = 0;
  for (const L of lines) {
    const visible = lineVisible(L);
    for (const dir of L.dirs) {
      let deps;
      if (L.live) {
        deps = ensureTimes(L, dir);
        if (!deps) continue;
      } else {
        deps = syntheticDeps(L, dir.dur + 2);
      }
      for (const dep of deps) {
        const el = now - dep;
        if (el < 0 || el > dir.dur) continue;
        vehCount++;
        if (!visible) continue;
        const key = `${L.key}|${dir.id}|${Math.round(dep * 10)}`;
        active.add(key);
        const p = posOnDir(L, dir, el);
        let v = vehLayer[key];
        if (!v) {
          v = {};
          v.halo = L2veh(p, { radius: 9, fillColor: L.color, fillOpacity: 0.16, stroke: false, interactive: false });
          v.core = L2veh(p, { radius: L.kind === "vapur" ? 3.6 : 4.4, fillColor: L.color, fillOpacity: 1, color: "#ffffff", weight: 1.3 });
          v.core.bindTooltip("", { className: "st-tip", direction: "top", offset: [0, -7] });
          v.core.on("tooltipopen", () => {
            const el2 = nowEpochMin() - dep;
            v.core.setTooltipContent(
              `<span class="tip-lines"><span class="tip-badge" style="background:${L.color}">${L.key}</span></span>` +
              `${dir.destName} yönü · sıradaki: ${nextStopName(dir, el2)}`
            );
          });
          vehLayer[key] = v;
        }
        v.halo.setLatLng(p);
        v.core.setLatLng(p);
      }
    }
  }
  for (const key in vehLayer) {
    if (!active.has(key)) {
      map.removeLayer(vehLayer[key].halo);
      map.removeLayer(vehLayer[key].core);
      delete vehLayer[key];
    }
  }
  $("#brandSub").innerHTML = `<b>${lines.length}</b> hat · <b>${vehCount}</b> araç (tarife tahmini)${alertCount ? ` · <b style="color:#ff7b7b">${alertCount} uyarı</b>` : ""}`;
  const sv = $("#statVeh");
  if (sv) sv.textContent = vehCount;
}
function L2veh(p, opts) {
  return L.circleMarker(p, { renderer: canvas, ...opts }).addTo(map);
}
function clearVehicles() {
  for (const key in vehLayer) {
    map.removeLayer(vehLayer[key].halo);
    map.removeLayer(vehLayer[key].core);
    delete vehLayer[key];
  }
}

// ---------- clock ----------
setInterval(() => {
  const d = new Date();
  $("#clock").textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}, 500);

// ---------- service status ----------
let alerts = [];
let alertCount = 0;
async function refreshStatus() {
  for (const base of [API_V2, API_V1]) {
    try {
      const r = await fetch(`${base}/GetServiceStatuses`);
      if (!r.ok) continue;
      const data = unwrap(await r.json());
      if (!Array.isArray(data)) continue;
      alerts = data.filter((a) => a.IsActive);
      alertCount = alerts.length;
      renderAlerts();
      return;
    } catch (e) { /* sıradaki */ }
  }
}
function renderAlerts() {
  const el = $("#alerts");
  el.innerHTML = alerts.map((a) =>
    `<div class="alert"><strong>${a.LineName}</strong> — ${a.Description}</div>`
  ).join("");
  document.querySelectorAll(".chip").forEach((c) => {
    const has = alerts.some((a) => a.LineName === c.dataset.key);
    c.querySelector(".alert-dot")?.remove();
    if (has) c.insertAdjacentHTML("beforeend", '<span class="alert-dot"></span>');
  });
}

// ---------- panel: chips + focus ----------
const GROUP_DEFS = [
  { label: "Metro", match: (l) => l.kind === "metro" },
  { label: "Tramvay", match: (l) => l.kind === "tramvay" },
  { label: "Füniküler & Teleferik", match: (l) => l.kind === "funikuler" || l.kind === "teleferik" },
  { label: "Marmaray & Metrobüs", match: (l) => l.kind === "marmaray" || l.kind === "metrobus" },
  { label: "Vapur", match: (l) => l.kind === "vapur" },
];
function renderChips() {
  const wrap = $("#groups");
  wrap.innerHTML = "";
  for (const g of GROUP_DEFS) {
    const ls = lines.filter(g.match);
    if (!ls.length) continue;
    const kinds = [...new Set(ls.map((l) => l.kind))];
    const div = document.createElement("div");
    div.innerHTML = `<div class="group-label"><span>${g.label}</span><button data-kinds="${kinds.join(",")}">gizle</button></div><div class="chips"></div>`;
    const chips = div.querySelector(".chips");
    for (const l of ls) {
      const b = document.createElement("button");
      b.className = "chip";
      b.dataset.key = l.key;
      b.style.background = l.color;
      b.style.color = pickText(l.color);
      b.textContent = l.kind === "vapur" ? l.name : (l.name || l.key);
      b.title = l.desc || l.key;
      b.addEventListener("click", () => toggleFocus(l.key));
      chips.appendChild(b);
    }
    div.querySelector(".group-label button").addEventListener("click", (ev) => {
      const btn = ev.currentTarget;
      const kk = btn.dataset.kinds.split(",");
      const hiding = !kk.every((k) => hiddenKinds.has(k));
      kk.forEach((k) => hiding ? hiddenKinds.add(k) : hiddenKinds.delete(k));
      btn.textContent = hiding ? "göster" : "gizle";
      applyVisibility();
    });
    wrap.appendChild(div);
  }
}
function pickText(hex) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 168 ? "#10151f" : "#ffffff";
}
function toggleFocus(key) {
  focusKey = focusKey === key ? null : key;
  document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("focused", c.dataset.key === focusKey));
  applyVisibility();
  const card = $("#linecard");
  if (!focusKey) { card.hidden = true; return; }
  const L = lineByKey[key];
  const b = allBounds(L);
  if (b) map.flyToBounds(b, { padding: [60, 60], maxZoom: 13.5, duration: 0.8 });
  fillLineCard(L);
  card.hidden = false;
}
function allBounds(L) {
  let pts;
  if (schematic && L.stations && L.stations.length) pts = L.stations.map(stStopPos);
  else pts = L.path ? L.path : (L.stations || []).map((s) => [s.lat, s.lng]);
  return pts.length ? window.L.latLngBounds(pts) : null;
}
function fillLineCard(L) {
  const card = $("#linecard");
  const alert = alerts.find((a) => a.LineName === L.key);
  let hw = null;
  if (L.headways) {
    const mins = [...new Set(L.headways.map((h) => Math.round(h.secs / 60)))].sort((a, b) => a - b);
    hw = mins.length === 1
      ? `${mins[0]} dk'da bir`
      : `${mins[0]}–${mins[mins.length - 1]} dk (saate göre)`;
  }
  const story = L.story && ((L.story.intro && L.story.intro.length) || (L.story.facts && L.story.facts.length));
  card.innerHTML = `
    <div class="linecard-head">
      <span class="line-badge" style="background:${L.color};color:${pickText(L.color)}">${L.name || L.key}</span>
      <h3>${L.desc || ""}</h3>
    </div>
    <dl>
      <dt>Tür</dt><dd>${KIND_LABEL[L.kind] || L.kind}</dd>
      <dt>İlk / son sefer</dt><dd>${L.first || "—"} / ${L.last || "—"}</dd>
      ${L.stations && L.stations.length ? `<dt>İstasyon</dt><dd>${L.stations.length}</dd>` : ""}
      ${L.km ? `<dt>Uzunluk</dt><dd>~${fmtKm(L.km)}</dd>` : ""}
      ${hw ? `<dt>Sıklık</dt><dd>${hw}</dd>` : `<dt>Sefer saatleri</dt><dd>canlı tarifeden</dd>`}
    </dl>
    ${alert ? `<div class="alert" style="margin-top:8px"><strong>${alert.LineName}</strong> — ${alert.Description}</div>` : ""}
    ${story ? `
    <details class="story">
      <summary>Hat hikâyesi &amp; bilgiler</summary>
      ${(L.story.intro || []).map((p) => `<p>${p}</p>`).join("")}
      ${L.story.facts && L.story.facts.length ? `<dl>${L.story.facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>` : ""}
    </details>` : ""}
    ${L.schematic ? `<p class="schematic-note">◈ Bu hattın konumları şematiktir (yaklaşık güzergâh).</p>` : ""}
  `;
}
function applyVisibility() {
  const dim = routeActive ? 0.28 : 1; // rota çizili: ağ arka plana çekilsin
  for (const L of lines) {
    const on = lineVisible(L);
    for (const rec of lineLayers[L.key] || []) {
      rec.layer.setStyle({
        weight: rec.w + (schematic ? 0.8 : 0),
        opacity: rec.under
          ? (on ? 0.55 * dim : 0)
          : (on ? (L.kind === "vapur" ? 0.7 : 0.92) * dim : (focusKey && !hiddenKinds.has(L.kind) && !growthYear ? 0.1 : 0)),
      });
    }
  }
  for (const s of stationMarkers) s.on = lineVisible(s.line);
  scaleStations();
  tick();
}

// ---------- LED arrival board ----------
let boardGroup = null;
let boardTimer = null;

function amenities(g) {
  const api = g.members.filter((m) => m.line.live);
  if (!api.length) return "";
  const lift = Math.max(0, ...api.map((m) => m.st.lift || 0));
  const esc = Math.max(0, ...api.map((m) => m.st.esc || 0));
  const items = [];
  if (lift) items.push(`ASANSÖR ${lift}`);
  if (esc) items.push(`Y.MERDİVEN ${esc}`);
  if (api.some((m) => m.st.wc)) items.push("WC");
  if (api.some((m) => m.st.baby)) items.push("BEBEK ODASI");
  if (api.some((m) => m.st.mescit)) items.push("MESCİT");
  return items.length ? items.map((i) => `<span>${i}</span>`).join('<span class="amen-sep">·</span>') : "";
}

async function openBoard(g) {
  boardGroup = g;
  $("#board").hidden = false;
  $("#boardName").textContent = g.display.toLocaleUpperCase("tr");
  const am = amenities(g);
  const amEl = $("#boardAmen");
  amEl.innerHTML = am;
  amEl.hidden = !am;
  $("#boardRows").innerHTML = '<div class="board-empty">SORGULANIYOR…</div>';
  $("#boardFoot").textContent = "";
  await renderBoard();
  clearInterval(boardTimer);
  boardTimer = setInterval(renderBoard, 30000);
}
$("#boardClose").addEventListener("click", () => {
  $("#board").hidden = true;
  boardGroup = null;
  clearInterval(boardTimer);
});

async function renderBoard() {
  if (!boardGroup) return;
  const g = boardGroup;
  const rows = [];
  let liveUsed = false, scheduleUsed = false;

  const jobs = [];
  for (const m of g.members) {
    const L = m.line;
    if (L.live) {
      for (const dir of L.dirs) {
        const inDir = dir.stops.findIndex((s) => s.id === m.st.id);
        if (inDir < 0 || inDir === dir.stops.length - 1) continue;
        jobs.push((async () => {
          const raw = await apiTimeTable(m.st.id, dir.id, new Date());
          if (raw && raw.length) {
            liveUsed = true;
            const ep = timesToEpoch(raw, new Date());
            rows.push({ L, dest: dir.destName, times: ep.slice(0, 3), live: true });
          } else if (raw && !raw.length) {
            rows.push({ L, dest: dir.destName, times: [], live: true });
          } else {
            const cached = tt[dir.id] && tt[dir.id].times;
            if (cached && cached.length) {
              const offset = dir.stops[inDir].min;
              const now = nowEpochMin();
              const ep = cached.map((t) => t + offset).filter((t) => t > now - 0.3);
              rows.push({ L, dest: dir.destName, times: ep.slice(0, 3), live: false });
              scheduleUsed = true;
            }
          }
        })());
      }
    } else {
      for (const dir of L.dirs) {
        const sts = L.stations;
        const idx = sts.findIndex((s) => norm(s.name) === norm(m.st.name));
        if (idx < 0) continue;
        const lastIdx = dir.rev ? 0 : sts.length - 1;
        if (idx === lastIdx) continue;
        const stMin = dir.rev ? (dir.dur - sts[idx].cumMin) : sts[idx].cumMin;
        const now = nowEpochMin();
        const ep = syntheticDeps(L, dir.dur + 2).map((d) => d + stMin).filter((t) => t > now - 0.3);
        rows.push({ L, dest: dir.destName, times: ep.slice(0, 3), live: false, schematic: L.schematic });
        scheduleUsed = true;
      }
    }
  }
  await Promise.all(jobs);
  if (boardGroup !== g) return;

  rows.sort((a, b) => (a.L.key > b.L.key ? 1 : -1));
  const now = nowEpochMin();
  const html = rows.map((r) => {
    if (!r.times.length) {
      return rowHTML(r, "SEFERDIŞI", "");
    }
    const eta = r.times[0] - now;
    const etaTxt = eta < 0.75 ? "ŞİMDİ" : `${Math.round(eta)} dk`;
    const nexts = r.times.slice(1).map(fmtHM).join(" · ");
    return rowHTML(r, etaTxt, nexts, eta < 0.75);
  }).join("");
  $("#boardRows").innerHTML = html || '<div class="board-empty">BU İSTASYON İÇİN VERİ YOK</div>';
  const d = new Date();
  $("#boardFoot").textContent =
    (liveUsed ? "CANLI TARİFE" : "TARİFE TAHMİNİ") +
    (scheduleUsed && liveUsed ? " + TAHMİN" : "") +
    ` · GÜNCELLEME ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function rowHTML(r, eta, nexts, isNow) {
  return `<div class="board-row">
    <span class="line-badge" style="background:${r.L.color};color:${pickText(r.L.color)}">${r.L.name || r.L.key}</span>
    <span class="board-dest">${r.dest}</span>
    <span class="board-eta${isNow ? " now" : ""}">${eta}</span>
    <span class="board-next">${nexts}</span>
  </div>`;
}

// ---------- search ----------
const searchEl = $("#search");
const resEl = $("#searchResults");
searchEl.addEventListener("input", () => {
  const q = norm(searchEl.value);
  if (q.length < 2) { resEl.hidden = true; return; }
  const hits = groups.filter((g) => g.key.includes(q)).slice(0, 8);
  resEl.innerHTML = hits.map((g) =>
    `<button class="search-item" data-i="${groups.indexOf(g)}">${tipHTML(g)}</button>`
  ).join("");
  resEl.hidden = !hits.length;
});
resEl.addEventListener("click", (ev) => {
  const b = ev.target.closest(".search-item");
  if (!b) return;
  const g = groups[+b.dataset.i];
  resEl.hidden = true;
  searchEl.value = g.display;
  map.flyTo(gPos(g), 14.5, { duration: 0.9 });
  openBoard(g);
  if (window.innerWidth <= 760) $("#panel").classList.remove("open");
});
document.addEventListener("click", (ev) => {
  if (!ev.target.closest(".search-wrap")) resEl.hidden = true;
  if (!ev.target.closest(".route-wrap")) $("#routeResults").hidden = true;
});

// ---------- route planner (Dijkstra, aktarma + yürüme bağlantılı) ----------
let routeGraph = null;
let routeFromG = null, routeToG = null;
let routeLayers = [];
let routeActive = false;

function buildGraph() {
  const adj = new Map();
  const add = (a, b, w, info) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push({ to: b, w, info }); };
  const gi = new Map(groups.map((g, i) => [g, i]));
  for (const L of lines) {
    if (L.kind === "vapur") continue;
    // ortalama bekleme (biniş cezası): sık hatlarda düşük
    const boardW = L.kind === "metrobus" ? 1.5 : L.kind === "marmaray" ? 7.5 : L.live ? 4 : 6;
    const seqs = L.live
      ? L.dirs.map((d) => d.stops.map((e) => ({ g: e._st && e._st._g, t: e.min })))
      : L.dirs.map((d) => {
          const sts = d.rev ? [...L.stations].reverse() : L.stations;
          return sts.map((s) => ({ g: s._g, t: d.rev ? (d.dur - s.cumMin) : s.cumMin }));
        });
    const gset = new Set();
    for (const seq of seqs) {
      const clean = seq.filter((x) => x.g);
      clean.forEach((x) => gset.add(x.g));
      for (let i = 1; i < clean.length; i++) {
        const a = clean[i - 1], b = clean[i];
        if (a.g === b.g) continue;
        add(`${gi.get(a.g)}|${L.key}`, `${gi.get(b.g)}|${L.key}`, Math.max(0.5, b.t - a.t), { type: "ride", line: L, from: a.g, to: b.g });
      }
    }
    for (const g of gset) {
      add(`G${gi.get(g)}`, `${gi.get(g)}|${L.key}`, boardW, { type: "board", line: L, at: g });
      add(`${gi.get(g)}|${L.key}`, `G${gi.get(g)}`, 0.5, { type: "alight", line: L, at: g });
    }
  }
  // yakın istasyonlar arası yürüme bağlantısı (adı farklı aktarmalar için)
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const d = distM([groups[i].lat, groups[i].lng], [groups[j].lat, groups[j].lng]);
      if (d < 420) {
        const w = Math.max(2, d / 75);
        add(`G${i}`, `G${j}`, w, { type: "walk", from: groups[i], to: groups[j], meters: d });
        add(`G${j}`, `G${i}`, w, { type: "walk", from: groups[j], to: groups[i], meters: d });
      }
    }
  }
  return { adj, gi };
}
function dijkstra(adj, src, dst) {
  const dist = new Map([[src, 0]]);
  const prev = new Map();
  const done = new Set();
  const pq = [[0, src]];
  while (pq.length) {
    let bi = 0;
    for (let i = 1; i < pq.length; i++) if (pq[i][0] < pq[bi][0]) bi = i;
    const [d, u] = pq.splice(bi, 1)[0];
    if (done.has(u)) continue;
    done.add(u);
    if (u === dst) break;
    for (const e of adj.get(u) || []) {
      const nd = d + e.w;
      if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); prev.set(e.to, { u, e }); pq.push([nd, e.to]); }
    }
  }
  if (!prev.has(dst)) return null;
  const edges = [];
  let cur = dst;
  while (cur !== src) { const p = prev.get(cur); if (!p) break; edges.unshift(p.e); cur = p.u; }
  return { edges, total: dist.get(dst) };
}
function computeRoute(gFrom, gTo) {
  if (!routeGraph) routeGraph = buildGraph();
  const { adj, gi } = routeGraph;
  const res = dijkstra(adj, `G${gi.get(gFrom)}`, `G${gi.get(gTo)}`);
  if (!res) return null;
  const legs = [];
  for (const ed of res.edges) {
    const i = ed.info;
    if (i.type === "ride") {
      const last = legs[legs.length - 1];
      if (last && last.type === "ride" && last.line === i.line) { last.stops.push(i.to); last.min += ed.w; }
      else legs.push({ type: "ride", line: i.line, from: i.from, stops: [i.to], min: ed.w, wait: 0 });
    } else if (i.type === "board") {
      legs.push({ type: "wait", line: i.line, min: ed.w });
    } else if (i.type === "walk") {
      legs.push({ type: "walk", from: i.from, to: i.to, min: ed.w, meters: i.meters });
    }
  }
  const merged = [];
  for (let i = 0; i < legs.length; i++) {
    const l = legs[i];
    if (l.type === "wait") {
      if (legs[i + 1] && legs[i + 1].type === "ride" && legs[i + 1].line === l.line) legs[i + 1].wait = l.min;
      continue;
    }
    merged.push(l);
  }
  return { legs: merged, total: res.total };
}
function clearRoute(full) {
  for (const l of routeLayers) map.removeLayer(l);
  routeLayers = [];
  routeActive = false;
  $("#routeResult").hidden = true;
  $("#routeClear").hidden = true;
  if (full) {
    routeFromG = routeToG = null;
    $("#routeFrom").value = ""; $("#routeTo").value = "";
  }
  applyVisibility();
}
function findDirFor(line, gFrom, gNext) {
  for (const dir of line.dirs) {
    if (!dir.stops) continue;
    let iF = -1, iN = -1;
    dir.stops.forEach((e, i) => {
      const g = e._st && e._st._g;
      if (g === gFrom && iF < 0) iF = i;
      if (g === gNext && iN < 0) iN = i;
    });
    if (iF >= 0 && iN > iF) return { dir, stopId: dir.stops[iF].id };
  }
  return null;
}
async function showRoute() {
  if (!routeFromG || !routeToG || routeFromG === routeToG) return;
  clearRoute(false);
  const r = computeRoute(routeFromG, routeToG);
  const el = $("#routeResult");
  el.hidden = false;
  $("#routeClear").hidden = false;
  if (!r) { el.innerHTML = '<p class="route-none">Rota bulunamadı — bu iki nokta ağ üzerinde bağlantısız görünüyor.</p>'; return; }
  routeActive = true;
  applyVisibility(); // ağı soluklaştır, rota öne çıksın

  // haritaya çiz
  const allPts = [];
  for (const leg of r.legs) {
    if (leg.type === "ride") {
      const pts = [gPos(leg.from), ...leg.stops.map(gPos)];
      routeLayers.push(L.polyline(pts, { renderer: canvas, interactive: false, color: "#ffffff", weight: 10, opacity: 0.30 }).addTo(map));
      routeLayers.push(L.polyline(pts, { renderer: canvas, interactive: false, color: leg.line.color, weight: 5.5, opacity: 1 }).addTo(map));
      allPts.push(...pts);
    } else if (leg.type === "walk") {
      const pts = [gPos(leg.from), gPos(leg.to)];
      routeLayers.push(L.polyline(pts, { renderer: canvas, interactive: false, color: "#e8edf5", weight: 3, opacity: 0.8, dashArray: "2 7" }).addTo(map));
      allPts.push(...pts);
    }
  }
  if (allPts.length) map.flyToBounds(window.L.latLngBounds(allPts), { padding: [70, 70], duration: 0.8 });

  // adım listesi
  const rows = r.legs.map((leg) => {
    if (leg.type === "walk") {
      return `<div class="route-leg"><span class="route-walk">🚶</span>
        <div><b>${leg.from.display} → ${leg.to.display}</b><small>yürüme ~${Math.round(leg.meters)} m · ${Math.round(leg.min)} dk</small></div></div>`;
    }
    const dest = leg.stops[leg.stops.length - 1];
    return `<div class="route-leg">
      <span class="line-badge" style="background:${leg.line.color};color:${pickText(leg.line.color)}">${leg.line.name || leg.line.key}</span>
      <div><b>${leg.from.display} → ${dest.display}</b>
      <small>${leg.stops.length} durak · ${Math.round(leg.min)} dk${leg.wait ? ` (+~${Math.round(leg.wait)} dk bekleme)` : ""}</small></div></div>`;
  }).join("");
  el.innerHTML = `
    <div class="route-total"><b>~${Math.round(r.total)} dk</b><span>${routeFromG.display} → ${routeToG.display}</span></div>
    ${rows}
    <p class="route-live" id="routeLive"></p>
    <p class="route-note">Süreler tarife + ortalama bekleme tahminidir.</p>`;

  // ilk biniş için canlı kalkış
  const firstRide = r.legs.find((l) => l.type === "ride");
  if (firstRide && firstRide.line.live) {
    const fd = findDirFor(firstRide.line, firstRide.from, firstRide.stops[0]);
    if (fd) {
      const raw = await apiTimeTable(fd.stopId, fd.dir.id, new Date());
      const liveEl = $("#routeLive");
      if (raw && raw.length && liveEl) {
        const ep = timesToEpoch(raw, new Date());
        const eta = ep[0] - nowEpochMin();
        if (eta >= -0.2 && eta < 90) liveEl.innerHTML = `● İlk biniş (${firstRide.line.key}): <b>${eta < 0.75 ? "ŞİMDİ" : Math.round(eta) + " dk sonra"}</b> <span>(canlı tarife)</span>`;
      }
    }
  }
}
function attachStationPicker(input, onPick) {
  const res = $("#routeResults");
  input.addEventListener("input", () => {
    const q = norm(input.value);
    if (q.length < 2) { res.hidden = true; return; }
    const hits = groups.filter((g) => g.key.includes(q)).slice(0, 7);
    res.innerHTML = hits.map((g) => `<button class="search-item" data-i="${groups.indexOf(g)}">${tipHTML(g)}</button>`).join("");
    res.hidden = !hits.length;
    res._active = input;
  });
  input.addEventListener("focus", () => { if (res._active !== input) res.hidden = true; });
}
$("#routeResults").addEventListener("click", (ev) => {
  const b = ev.target.closest(".search-item");
  if (!b) return;
  const g = groups[+b.dataset.i];
  const res = $("#routeResults");
  const input = res._active;
  res.hidden = true;
  if (!input) return;
  input.value = g.display;
  if (input.id === "routeFrom") routeFromG = g; else routeToG = g;
  if (routeFromG && routeToG) showRoute();
  else (input.id === "routeFrom" ? $("#routeTo") : $("#routeFrom")).focus();
});
attachStationPicker($("#routeFrom"));
attachStationPicker($("#routeTo"));
$("#routeClear").addEventListener("click", () => clearRoute(true));

// ---------- schematic layout (oktilineer gevşetme, 2 faz) ----------
function buildSchematic() {
  const kx = Math.cos(41.02 * Math.PI / 180) * 111;
  const nodes = [];
  for (const g of groups) {
    g._n = { x: g.lng * kx, y: g.lat * 111, x0: g.lng * kx, y0: g.lat * 111, deg: 0 };
    nodes.push(g._n);
  }
  // kenarlar + hat zincirleri (hat boyu düzlük kuvveti için)
  const eKey = new Set();
  const edges = [];
  const chainsN = [];
  const addEdge = (na, nb) => {
    if (!na || !nb || na === nb) return;
    const k = na._i < nb._i ? na._i + "|" + nb._i : nb._i + "|" + na._i;
    if (eKey.has(k)) return;
    eKey.add(k);
    edges.push({ a: na, b: nb });
    na.deg++; nb.deg++;
  };
  nodes.forEach((n, i) => (n._i = i));
  for (const L of lines) {
    if (L.kind === "vapur") continue;
    const rawChains = L.live
      ? drawChains(L).map((ch) => ch.map((e) => e._st && e._st._g && e._st._g._n))
      : [L.stations.map((s) => s._g && s._g._n)];
    for (const rc of rawChains) {
      const ch = [];
      for (const n of rc) { if (n && ch[ch.length - 1] !== n) ch.push(n); }
      if (ch.length < 2) continue;
      chainsN.push(ch);
      for (let i = 1; i < ch.length; i++) addEdge(ch[i - 1], ch[i]);
    }
  }
  const lens = edges.map((e) => Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y)).sort((x, y) => x - y);
  const L0 = lens[Math.floor(lens.length / 2)] || 1;
  const STEP = Math.PI / 4;
  const minD = L0 * 0.45, minD2 = minD * minD;
  // faz 1: kaba yerleşim; faz 2: sert açı oturtma, coğrafya bağı gevşek
  const phases = [
    { it: 260, k: 0.18, anchor: 0.010, straight: 0.10 },
    { it: 300, k: 0.45, anchor: 0.0015, straight: 0.28 },
  ];
  for (const ph of phases) {
    for (let it = 0; it < ph.it; it++) {
      for (const e of edges) {
        const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
        const len = Math.hypot(dx, dy) || 1e-6;
        const snap = Math.round(Math.atan2(dy, dx) / STEP) * STEP;
        // eşit aralığa yakın durak dizilimi (diyagram hissi)
        let tlen = L0 * Math.min(Math.max(Math.pow(len / L0, 0.25), 0.6), 2.0);
        const mx = (e.a.x + e.b.x) / 2, my = (e.a.y + e.b.y) / 2;
        const hx = Math.cos(snap) * tlen / 2, hy = Math.sin(snap) * tlen / 2;
        const ka = ph.k / Math.sqrt(e.a.deg || 1), kb = ph.k / Math.sqrt(e.b.deg || 1);
        e.a.x += (mx - hx - e.a.x) * ka; e.a.y += (my - hy - e.a.y) * ka;
        e.b.x += (mx + hx - e.b.x) * kb; e.b.y += (my + hy - e.b.y) * kb;
      }
      // hat boyu düzlük: 150°'den açık dirsekler tam düzleşir (merdivenlenme kırıcı)
      for (const ch of chainsN) {
        for (let j = 1; j < ch.length - 1; j++) {
          const A = ch[j - 1], N = ch[j], B = ch[j + 1];
          const v1x = A.x - N.x, v1y = A.y - N.y, v2x = B.x - N.x, v2y = B.y - N.y;
          const cos = (v1x * v2x + v1y * v2y) / ((Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y)) || 1);
          if (cos < -0.87) {
            N.x += ((A.x + B.x) / 2 - N.x) * ph.straight;
            N.y += ((A.y + B.y) / 2 - N.y) * ph.straight;
          }
        }
      }
      // ilgisiz düğümler birbirine yapışmasın (3 iterde bir)
      if (it % 3 === 0) {
        for (let i = 0; i < nodes.length; i++) {
          const a = nodes[i];
          for (let j = i + 1; j < nodes.length; j++) {
            const b = nodes[j];
            const dx = b.x - a.x, dy = b.y - a.y;
            const d2 = dx * dx + dy * dy;
            if (d2 >= minD2 || d2 < 1e-9) continue;
            const d = Math.sqrt(d2);
            const push = ((minD - d) / d) * 0.10;
            a.x -= dx * push; a.y -= dy * push;
            b.x += dx * push; b.y += dy * push;
          }
        }
      }
      for (const n of nodes) { n.x += (n.x0 - n.x) * ph.anchor; n.y += (n.y0 - n.y) * ph.anchor; }
    }
  }
  // orijinal coğrafi kutuya geri ölçekle
  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
  const x0s = nodes.map((n) => n.x0), y0s = nodes.map((n) => n.y0);
  const mm = (a) => [Math.min(...a), Math.max(...a)];
  const [xA, xB] = mm(xs), [yA, yB] = mm(ys), [gxA, gxB] = mm(x0s), [gyA, gyB] = mm(y0s);
  for (const g of groups) {
    const n = g._n;
    const fx = (n.x - xA) / ((xB - xA) || 1), fy = (n.y - yA) / ((yB - yA) || 1);
    g.slng = (gxA + fx * (gxB - gxA)) / kx;
    g.slat = (gyA + fy * (gyB - gyA)) / 111;
  }
}

// ---------- mode switch (coğrafi <-> şematik) ----------
let schemBuilt = false;
function chainPts(chain, schem) {
  return chain.map((e) => {
    const st = e._st || e; // canlı yön durağı veya statik istasyon
    const g = st._g;
    return (schem && g && g.slat != null) ? [g.slat, g.slng] : [e.lat != null ? e.lat : st.lat, e.lng != null ? e.lng : st.lng];
  });
}
function setMode(schem, instant) {
  if (schem === schematic || morphing) return;
  if (schem && !schemBuilt) { buildSchematic(); schemBuilt = true; }
  const btn = $("#modeBtn");
  btn.textContent = schem ? "COĞRAFİ GÖRÜNÜM" : "ŞEMATİK GÖRÜNÜM";
  btn.setAttribute("aria-pressed", schem ? "true" : "false");
  document.body.classList.toggle("schematic", schem);

  // morph hedefleri
  const moves = [];
  for (const L of lines) {
    for (const rec of lineLayers[L.key] || []) {
      if (!rec.chain) continue; // vapurlar: zincirsiz, sadece görünürlük değişir
      const from = chainPts(rec.chain, schematic);
      const to = chainPts(rec.chain, schem);
      if (L.path && !schematic) rec.layer.setLatLngs(from); // detaylı yoldan zincire anlık geç
      moves.push({ set: (pts) => rec.layer.setLatLngs(pts), from, to, rec, L });
    }
  }
  const stMoves = stationMarkers.map((s) => ({
    set: (p) => s.marker.setLatLng(p),
    from: schematic ? [s.group.slat ?? s.member.st.lat, s.group.slng ?? s.member.st.lng] : [s.member.st.lat, s.member.st.lng],
    to: schem ? [s.group.slat ?? s.member.st.lat, s.group.slng ?? s.member.st.lng] : [s.member.st.lat, s.member.st.lng],
  }));

  schematic = schem;
  if (!instant) morphing = true; // morph bitmeden tick araç çizmesin
  clearVehicles();
  applyVisibility(); // vapur görünürlüğü vb.

  const finish = () => {
    morphing = false;
    // coğrafi moda dönüşte detaylı yolları geri koy
    if (!schem) {
      for (const mv of moves) if (mv.L.path) mv.set(mv.L.path);
    }
    scaleStations();
    tick();
    if (routeActive && routeFromG && routeToG) showRoute(); // rotayı yeni koordinatlarda yeniden çiz
    if (schem) {
      const all = [];
      for (const g of groups) if (g.slat != null) all.push([g.slat, g.slng]);
      map.flyToBounds(window.L.latLngBounds(all), { padding: [40, 40], duration: 0.7 });
    }
  };
  if (instant) {
    for (const mv of moves) mv.set(mv.to);
    for (const mv of stMoves) mv.set(mv.to);
    finish();
    return;
  }
  const t0 = performance.now(), DUR = 700;
  const ease = (t) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  const lerpPts = (a, b, f) => a.map((p, i) => [p[0] + (b[i][0] - p[0]) * f, p[1] + (b[i][1] - p[1]) * f]);
  const step = (now) => {
    const f = ease(Math.min(1, (now - t0) / DUR));
    for (const mv of moves) mv.set(lerpPts(mv.from, mv.to, f));
    for (const mv of stMoves) mv.set([
      mv.from[0] + (mv.to[0] - mv.from[0]) * f,
      mv.from[1] + (mv.to[1] - mv.from[1]) * f,
    ]);
    if (f < 1) requestAnimationFrame(step);
    else finish();
  };
  requestAnimationFrame(step);
}
$("#modeBtn").addEventListener("click", () => setMode(!schematic));

// ---------- stats overlay ----------
function renderStats() {
  const rail = lines.filter((l) => l.kind !== "vapur");
  const totalKm = rail.reduce((s, l) => s + (l.km || 0), 0);
  const byKm = [...rail].sort((a, b) => (b.km || 0) - (a.km || 0)).slice(0, 10);
  const bySt = [...rail].filter((l) => l.stations && l.stations.length > 2)
    .sort((a, b) => b.stations.length - a.stations.length).slice(0, 10);
  const maxKm = byKm[0].km, maxSt = bySt[0].stations.length;
  const years = rail.filter((l) => l.year).sort((a, b) => a.year - b.year);
  const bar = (L, val, max, label) => `
    <div class="sbar">
      <span class="line-badge" style="background:${L.color};color:${pickText(L.color)}">${L.name || L.key}</span>
      <span class="sbar-name">${L.desc || ""}</span>
      <span class="sbar-track"><span class="sbar-fill" style="width:${(val / max) * 100}%;background:${L.color}"></span></span>
      <span class="sbar-val">${label}</span>
    </div>`;
  $("#stats").innerHTML = `
    <div class="stats-inner">
      <div class="stats-head">
        <h2>AĞ İSTATİSTİKLERİ</h2>
        <button class="board-close" id="statsClose" aria-label="Kapat">✕</button>
      </div>
      <div class="tiles">
        <div class="tile"><b>${lines.length}</b><span>hat</span></div>
        <div class="tile"><b>${groups.length}</b><span>istasyon / durak</span></div>
        <div class="tile"><b>${Math.round(totalKm)}</b><span>km ağ (raylı + metrobüs)</span></div>
        <div class="tile"><b id="statVeh">${vehCount}</b><span>araç şu an (tahmini)</span></div>
      </div>
      <h3>En uzun hatlar</h3>
      <div class="sbars">${byKm.map((l) => bar(l, l.km, maxKm, fmtKm(l.km))).join("")}</div>
      <h3>En çok istasyon</h3>
      <div class="sbars">${bySt.map((l) => bar(l, l.stations.length, maxSt, l.stations.length)).join("")}</div>
      <h3>Ağın yaşı</h3>
      <p class="stats-note">İlk vapurlar <b>1851</b>'de (Şirket-i Hayriye), ilk metro <b>${years[0].year}</b>'da (${years[0].name || years[0].key}) yola çıktı.
      En genç hatlar: ${years.slice(-3).map((l) => `${l.name || l.key} (${l.year})`).join(", ")}.</p>
      <button class="grow-btn" id="growBtn">▸ AĞIN BÜYÜMESİNİ İZLE (1851 → BUGÜN)</button>
      <p class="stats-foot">Uzunluklar hat geometrisinden hesaplanmıştır, yaklaşık değerlerdir.</p>
    </div>`;
  $("#statsClose").addEventListener("click", closeStats);
  $("#growBtn").addEventListener("click", () => { closeStats(); growthPlay(); });
}
function openStats() { renderStats(); $("#stats").hidden = false; }
function closeStats() { $("#stats").hidden = true; }
$("#statsBtn").addEventListener("click", () => $("#stats").hidden ? openStats() : closeStats());

// ESC = ana görünüm: her şeyi kapat, tüm hatları göster, haritayı sıfırla
function goHome() {
  closeStats();
  $("#board").hidden = true; boardGroup = null; clearInterval(boardTimer);
  if (focusKey) toggleFocus(focusKey);
  hiddenKinds.clear();
  document.querySelectorAll(".group-label button").forEach((b) => (b.textContent = "gizle"));
  searchEl.value = ""; resEl.hidden = true;
  clearRoute(true);
  $("#panel").classList.remove("open");
  growthAbort = true;
  if (schematic) {
    const all = [];
    for (const g of groups) if (g.slat != null) all.push([g.slat, g.slng]);
    if (all.length) map.flyToBounds(window.L.latLngBounds(all), { padding: [40, 40], duration: 0.7 });
  } else {
    map.flyTo([41.035, 29.0], 11, { duration: 0.7 });
  }
  applyVisibility();
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") goHome(); });

// ---------- growth animation ----------
let growing = false;
let growthAbort = false;
async function growthPlay() {
  if (growing) return;
  growing = true;
  growthAbort = false;
  if (focusKey) toggleFocus(focusKey);
  const hud = $("#yearhud");
  const years = [...new Set(lines.filter((l) => l.year).map((l) => l.year))].sort((a, b) => a - b);
  const bounds = window.L.latLngBounds(
    lines.filter((l) => l.kind !== "vapur").flatMap((l) => (l.stations || []).map(stStopPos))
  );
  map.flyToBounds(bounds, { padding: [50, 50], duration: 0.6 });
  hud.hidden = false;
  let skip = false;
  const onSkip = () => { skip = true; };
  hud.addEventListener("click", onSkip);
  for (const y of years) {
    if (skip || growthAbort) break;
    growthYear = y;
    const opened = lines.filter((l) => l.year === y).map((l) => l.name || l.key);
    hud.innerHTML = `${y}<span>${opened.join(" · ")}</span>`;
    applyVisibility();
    await new Promise((r) => setTimeout(r, y === 1851 ? 1600 : 1100));
  }
  hud.innerHTML = `${new Date().getFullYear()}<span>bugünün ağı</span>`;
  await new Promise((r) => setTimeout(r, 1200));
  hud.removeEventListener("click", onSkip);
  hud.hidden = true;
  growthYear = null;
  applyVisibility();
  growing = false;
}

// ---------- mobile panel toggle ----------
$("#panelToggle").addEventListener("click", () => $("#panel").classList.toggle("open"));

// ---------- boot ----------
function parseHash() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (/sematik/.test(h)) setMode(true, true);
  if (/stats/.test(h)) openStats();
  const f = h.match(/focus=([^&]+)/);
  if (f && lineByKey[f[1]] && focusKey !== f[1]) toggleFocus(f[1]);
  const m = h.match(/st=([^&]+)/);
  if (m) {
    const g = groups.find((x) => x.key === norm(m[1]));
    if (g) { map.setView(gPos(g), 14); openBoard(g); }
  }
  const rt = h.match(/rota=([^>&]+)>([^&]+)/);
  if (rt) {
    const gFind = (q) => groups.find((x) => x.key === norm(q)) || groups.find((x) => x.key.includes(norm(q)));
    const gA = gFind(rt[1]);
    const gB = gFind(rt[2]);
    if (gA && gB) {
      routeFromG = gA; routeToG = gB;
      $("#routeFrom").value = gA.display; $("#routeTo").value = gB.display;
      showRoute();
    }
  }
}

drawAll();
renderChips();
refreshStatus();
setInterval(refreshStatus, 120000);
for (const L of lines) if (L.live) for (const dir of L.dirs) enqueueDir(L, dir);
tick();
setInterval(tick, 1000);
parseHash();
window.addEventListener("hashchange", parseHash);

})();
