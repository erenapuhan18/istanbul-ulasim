// bake.js — İstanbul transit data baker
// Pulls Metro İstanbul API (lines/stations/directions/between-times) and
// IBB GTFS (Marmaray shape+stops, ferry shapes, frequencies), writes data.js
const fs = require("fs");
const path = require("path");

const GTFS_DIR = path.join(__dirname, "gtfs");
const OUT = "C:/Users/erena/istanbul-ulasim/data.js";
const API = "https://api.ibb.gov.tr/MetroIstanbul/api/MetroMobile/V2";

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HDRS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Accept": "application/json" };
async function getJSON(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: HDRS });
      if (!r.ok) throw new Error(`${url} -> ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(1500 * (i + 1));
    }
  }
}
async function postJSON(url, body, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { ...HDRS, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`${url} -> ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(1500 * (i + 1));
    }
  }
}

// windows-1254 -> utf8 CSV reader
function readCsv1254(file) {
  const buf = fs.readFileSync(path.join(GTFS_DIR, file));
  const dec = new TextDecoder("windows-1254");
  const text = dec.decode(buf);
  return parseCsv(text);
}
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  const header = splitCsvLine(lines[0]);
  return lines.slice(1).map((l) => {
    const cells = splitCsvLine(l);
    const o = {};
    header.forEach((h, i) => (o[h.trim()] = (cells[i] || "").trim()));
    return o;
  });
}
function splitCsvLine(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

const R = 6371000;
function dist(a, b) {
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLng = ((b[1] - a[1]) * Math.PI) / 180;
  const la = (a[0] * Math.PI) / 180, lb = (b[0] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function pathLength(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += dist(pts[i - 1], pts[i]);
  return d;
}
// Douglas-Peucker in degrees (approx)
function simplify(pts, tolDeg) {
  if (pts.length < 3) return pts;
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = perpDist(pts[i], pts[s], pts[e]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tolDeg && idx > 0) { keep[idx] = true; stack.push([s, idx], [idx, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function perpDist(p, a, b) {
  const dx = b[1] - a[1], dy = b[0] - a[0];
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(p[1] - a[1], p[0] - a[0]);
  let t = ((p[1] - a[1]) * dx + (p[0] - a[0]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[1] - (a[1] + t * dx), p[0] - (a[0] + t * dy));
}
// project point onto nearest SEGMENT of path -> cumulative meters + offset
function projectOntoPath(pt, pts, cum) {
  let bestM = 0, bd = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b[1] - a[1], dy = b[0] - a[0];
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((pt[1] - a[1]) * dx + (pt[0] - a[0]) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const proj = [a[0] + t * dy, a[1] + t * dx];
    const d = dist(pt, proj);
    if (d < bd) { bd = d; bestM = cum[i] + t * (cum[i + 1] - cum[i]); }
  }
  return { meters: bestM, off: bd };
}
function cumMeters(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  return cum;
}
const trUp = (s) =>
  s.toLocaleUpperCase("tr").replace(/İ/g, "I").replace(/Ş/g, "S").replace(/Ğ/g, "G")
    .replace(/Ü/g, "U").replace(/Ö/g, "O").replace(/Ç/g, "C").replace(/[^A-Z0-9]/g, "");

// ---------- main ----------
// V2 down happens often; fall back to V1 (V1 returns a bare array, V2 wraps in {Data})
const unwrap = (j) => (j && j.Data !== undefined ? j.Data : j);
async function apiGet(name) {
  try { return unwrap(await getJSON(`${API}/${name}`, 2)); }
  catch (e) { console.log(`  V2 ${name} failed (${e.message}), trying V1`); return unwrap(await getJSON(`${API.replace("/V2", "")}/${name}`)); }
}
async function apiPost(name, body) {
  try { return unwrap(await postJSON(`${API}/${name}`, body, 2)); }
  catch (e) { return unwrap(await postJSON(`${API.replace("/V2", "")}/${name}`, body)); }
}

(async () => {
  console.log("== Metro İstanbul API ==");
  const linesRaw = await apiGet("GetLines");
  // V3 has the newest stations (M5 Sultanbeyli extension etc.)
  let stationsRaw;
  try { stationsRaw = unwrap(await getJSON(`${API.replace("/V2", "/V3")}/GetStations`, 2)); console.log("  stations from V3"); }
  catch (e) { stationsRaw = await apiGet("GetStations"); }
  const directionsRaw = await apiGet("GetDirections");
  console.log(`lines=${linesRaw.length} stations=${stationsRaw.length} directions=${directionsRaw.length}`);

  const KIND = (n) => (n.startsWith("M") ? "metro" : n.startsWith("TF") ? "teleferik" : n.startsWith("T") ? "tramvay" : "funikuler");

  // API has empty coords for M5's newest stations; hand-measured approximations
  const COORD_FIX = {
    "M5|VEYSELKARANI": [40.976, 29.245],
    "M5|HASANPASA": [40.968, 29.257],
    "M5|SULTANBEYLI": [40.9607, 29.269],
  };

  const lines = [];
  for (const L of linesRaw.sort((a, b) => a.Order - b.Order)) {
    const c = L.Color || {};
    const hex = "#" + [c.Color_R, c.Color_G, c.Color_B].map((v) => (+v || 0).toString(16).padStart(2, "0")).join("");
    const sts = stationsRaw
      .filter((s) => s.LineId === L.Id)
      .sort((a, b) => a.Order - b.Order)
      .map((s) => {
        let lat = +s.DetailInfo.Latitude, lng = +s.DetailInfo.Longitude;
        const fix = COORD_FIX[`${L.Name}|${trUp(s.Name)}`];
        if ((!isFinite(lat) || !lat) && fix) [lat, lng] = fix;
        return {
          id: s.Id,
          name: s.Description || s.Name,
          lat, lng,
          wc: !!s.DetailInfo.WC,
          lift: s.DetailInfo.Lift || 0,
          esc: s.DetailInfo.Escolator || 0,
          baby: !!s.DetailInfo.BabyRoom,
        };
      })
      .filter((s) => isFinite(s.lat) && isFinite(s.lng) && s.lat > 40 && s.lat < 42);

    const dirs = directionsRaw.filter((d) => d.LineId === L.Id);
    const directions = [];
    const failedDirs = [];
    for (const d of dirs) {
      try {
        // direction name is "Origin->Dest"; boarding station must lie on the direction
        const originName = trUp((d.DirectionName || "").split("->")[0] || "");
        const byName = sts.find((x) => trUp(x.name) === originName || trUp(x.name).includes(originName) || originName.includes(trUp(x.name)));
        const cands = [...new Set([byName, sts[0], sts[sts.length - 1], sts[Math.floor(sts.length / 2)]].filter(Boolean).map((s) => s.id))];
        let row = null;
        for (const cid of cands) {
          const bt = await apiPost("GetStationBetweenTime", {
            boardingStationId: cid,
            directionId: d.DirectionId,
            dateTime: new Date().toISOString().slice(0, 19),
          });
          await sleep(120);
          const r0 = (bt || [])[0];
          if (r0 && r0.StationOrder && r0.StationOrder.length) { row = r0; break; }
        }
        if (!row) { console.log(`  !! no BT for ${L.Name} dir ${d.DirectionId} (${d.DirectionName})`); failedDirs.push(d); continue; }
        const stops = row.StationOrder.sort((a, b) => a.Order - b.Order).map((s) => {
          const st = sts.find((x) => x.id === s.Id) || sts.find((x) => trUp(x.name) === trUp(s.StationName));
          return { id: s.Id, name: st ? st.name : s.StationName, min: s.Time, lat: st ? st.lat : null, lng: st ? st.lng : null };
        });
        const missing = stops.filter((s) => s.lat == null);
        if (missing.length) console.log(`  !! ${L.Name} dir ${d.DirectionId}: ${missing.length} stops without coords: ${missing.map((m) => m.name).join(",")}`);
        directions.push({
          id: d.DirectionId,
          name: d.DirectionName,
          stops: stops.filter((s) => s.lat != null),
        });
      } catch (e) {
        console.log(`  !! BT failed ${L.Name} dir ${d.DirectionId}: ${e.message}`);
        failedDirs.push(d);
      }
    }

    // synthesize a failed direction from its successful opposite ("B->A" from "A->B")
    for (const fd of failedDirs) {
      const [a, b] = (fd.DirectionName || "").split("->").map((x) => trUp(x || ""));
      const fwd = directions.find((x) => {
        const [xa, xb] = (x.name || "").split("->").map((y) => trUp(y || ""));
        return xa === b && xb === a && x.stops.length > 1;
      });
      if (fwd) {
        const total = fwd.stops[fwd.stops.length - 1].min;
        directions.push({
          id: fd.DirectionId, name: fd.DirectionName, synth: true,
          stops: [...fwd.stops].reverse().map((s) => ({ ...s, min: +(total - s.min).toFixed(1) })),
        });
        console.log(`  ++ ${L.Name}: reverse-synthesized ${fd.DirectionName}`);
      }
    }
    // no direction data at all (M3/M9): build from station order, distance-based times
    if (!directions.length && sts.length > 1 && dirs.length) {
      const speed = KIND(L.Name) === "tramvay" ? 18 : 34;
      const cum = cumMeters(sts.map((s) => [s.lat, s.lng]));
      const mins = cum.map((m) => +((m / 1000 / speed) * 60).toFixed(1));
      for (const d of dirs) {
        const [a] = (d.DirectionName || "").split("->").map((x) => trUp(x || ""));
        const s0 = trUp(sts[0].name);
        const fwdMatch = s0 === a || s0.includes(a) || a.includes(s0);
        const seq = fwdMatch
          ? sts.map((s, i) => ({ s, m: mins[i] }))
          : [...sts].reverse().map((s, i) => ({ s, m: +(mins[mins.length - 1] - mins[mins.length - 1 - i]).toFixed(1) }));
        directions.push({
          id: d.DirectionId, name: d.DirectionName, synth: true,
          stops: seq.map(({ s, m }) => ({ id: s.id, name: s.name, min: m, lat: s.lat, lng: s.lng })),
        });
      }
      console.log(`  ++ ${L.Name}: ${dirs.length} directions synthesized from station order`);
    }
    // normalize so each direction starts at min 0 (BT chains may start mid-line)
    for (const dd of directions) {
      const base = dd.stops.length ? dd.stops[0].min : 0;
      if (base) dd.stops = dd.stops.map((s) => ({ ...s, min: +(s.min - base).toFixed(1) }));
    }

    lines.push({
      key: L.Name, kind: KIND(L.Name), id: L.Id, desc: L.LongDescription,
      color: hex, firstTime: L.FirstTime, lastTime: L.LastTime,
      stations: sts, directions,
    });
    console.log(`  ${L.Name}: ${sts.length} st, ${directions.length} dir, color ${hex}`);
  }

  console.log("== GTFS ==");
  const routes = readCsv1254("routes.csv");
  const trips = readCsv1254("trips.csv");
  const freqs = readCsv1254("frequencies.csv");
  const stops = readCsv1254("stops.csv");
  console.log(`routes=${routes.length} trips=${trips.length} freqs=${freqs.length} stops=${stops.length}`);

  // shapes: stream-parse big file
  const shapesText = new TextDecoder("windows-1254").decode(fs.readFileSync(path.join(GTFS_DIR, "shapes.csv")));
  const shapeMap = {};
  {
    const rows = shapesText.split(/\r?\n/);
    const hdr = splitCsvLine(rows[0]).map((h) => h.trim());
    const iId = hdr.indexOf("shape_id"), iLat = hdr.indexOf("shape_pt_lat"), iLng = hdr.indexOf("shape_pt_lon"), iSeq = hdr.indexOf("shape_pt_sequence");
    for (let i = 1; i < rows.length; i++) {
      if (!rows[i]) continue;
      const c = splitCsvLine(rows[i]);
      const id = c[iId];
      if (!shapeMap[id]) shapeMap[id] = [];
      shapeMap[id].push([+c[iSeq], +c[iLat], +c[iLng]]);
    }
    for (const id in shapeMap) shapeMap[id] = shapeMap[id].sort((a, b) => a[0] - b[0]).map((r) => [r[1], r[2]]);
  }
  console.log(`shapes=${Object.keys(shapeMap).length}`);

  function headwaysForRoute(routeId) {
    const tIds = trips.filter((t) => t.route_id === routeId).map((t) => t.trip_id);
    const rows = freqs.filter((f) => tIds.includes(f.trip_id));
    const byPeriod = {};
    for (const r of rows) {
      const k = `${r.start_time}-${r.end_time}`;
      const h = +r.headway_secs;
      if (!byPeriod[k] || h < byPeriod[k].secs) byPeriod[k] = { from: r.start_time.slice(0, 5), to: r.end_time.slice(0, 5), secs: h };
    }
    return Object.values(byPeriod).sort((a, b) => a.from.localeCompare(b.from));
  }
  function shapeForRoute(routeId, dirId) {
    const t = trips.find((t) => t.route_id === routeId && (dirId == null || t.direction_id === String(dirId)) && shapeMap[t.shape_id]);
    return t ? shapeMap[t.shape_id] : null;
  }

  // --- Marmaray ---
  const MARMARAY_ORDER = ["GEBZE","DARICA","OSMANGAZI","FATIH","CAYIROVA","TUZLA","ICMELER","AYDINTEPE","GUZELYALI","TERSANE","KAYNARCA","PENDIK","YUNUS","KARTAL","BASAK","ATALAR","CEVIZLI","MALTEPE","SUREYYAPLAJI","IDEALTEPE","KUCUKYALI","BOSTANCI","SUADIYE","ERENKOY","GOZTEPE","FENERYOLU","SOGUTLUCESME","AYRILIKCESMESI","USKUDAR","SIRKECI","YENIKAPI","KAZLICESME","ZEYTINBURNU","YENIMAHALLE","BAKIRKOY","ATAKOY","YESILYURT","YESILKOY","FLORYA","FLORYAAKVARYUM","KUCUKCEKMECE","MUSTAFAKEMAL","HALKALI"];
  let marmaray = null;
  {
    const shape = shapeForRoute("26615", 0) || shapeForRoute("26615", null); // dir 0 = HALKALI (Gebze->Halkalı)
    if (shape) {
      const simp = simplify(shape, 0.00015);
      const cum = cumMeters(simp);
      const total = cum[cum.length - 1];
      // candidate stops near shape
      const near = stops
        .map((s) => ({ name: s.stop_name, key: trUp(s.stop_name || ""), lat: +s.stop_lat, lng: +s.stop_lon }))
        .filter((s) => isFinite(s.lat) && s.lat > 40 && s.lat < 42);
      const sts = [];
      for (const want of MARMARAY_ORDER) {
        let cands = near.filter((s) => s.key === want);
        if (!cands.length) cands = near.filter((s) => s.key.includes(want) || (want.length > 5 && s.key && want.includes(s.key)));
        let best = null, bd = Infinity;
        for (const c of cands) {
          const p = projectOntoPath([c.lat, c.lng], simp, cum);
          if (p.off < 350 && p.off < bd) { bd = p.off; best = { ...c, meters: p.meters }; }
        }
        if (best) sts.push(best);
        else console.log(`  !! Marmaray stop not matched: ${want}`);
      }
      sts.sort((a, b) => a.meters - b.meters);
      const DURATION = 113; // dakika, Gebze-Halkalı resmi
      marmaray = {
        key: "MARMARAY", kind: "banliyo", name: "Marmaray", desc: "Gebze – Halkalı",
        color: "#00937E", firstTime: "06:00", lastTime: "00:00",
        path: simp.map((p) => [+p[0].toFixed(5), +p[1].toFixed(5)]),
        durationMin: DURATION,
        stations: sts.map((s) => ({ name: title(s.name), lat: +s.lat.toFixed(5), lng: +s.lng.toFixed(5), cumMin: +((s.meters / total) * DURATION).toFixed(1) })),
        headways: headwaysForRoute("26615"),
      };
      console.log(`Marmaray: shape ${simp.length} pts, ${sts.length}/43 stations, headways ${marmaray.headways.length}`);
    } else console.log("  !! no Marmaray shape");
  }

  // --- Ferries ---
  const FERRY_IDS = [
    ["809", "Kadıköy – Beşiktaş"],
    ["830", "Üsküdar – Eminönü"],
    ["26716", "Kabataş – Kadıköy – Adalar"],
    ["7060", "Bostancı – Karaköy – Kabataş"],
    ["2062", "Kadıköy – Sarıyer (Boğaz)"],
    ["28195", "Beşiktaş – Karaköy – Haliç"],
  ];
  const ferries = [];
  for (const [rid, label] of FERRY_IDS) {
    const shape = shapeForRoute(rid, null);
    if (!shape) { console.log(`  !! no shape for ferry ${rid}`); continue; }
    const simp = simplify(shape, 0.0004);
    const lenKm = pathLength(simp) / 1000;
    ferries.push({
      key: "V" + rid, name: label, color: "#5FB3E8",
      path: simp.map((p) => [+p[0].toFixed(5), +p[1].toFixed(5)]),
      durationMin: Math.round((lenKm / 26) * 60), // ~26 km/h vapur
      headways: headwaysForRoute(rid),
    });
    console.log(`Ferry ${label}: ${simp.length} pts, ${lenKm.toFixed(1)} km, ${headwaysForRoute(rid).length} freq periods`);
  }

  function title(s) {
    return (s || "").toLocaleLowerCase("tr").split(/\s+/).map((w) => w.charAt(0).toLocaleUpperCase("tr") + w.slice(1)).join(" ");
  }

  // --- hand-drawn schematic layers (no open data source) ---
  function withCumMin(stops2, speedKmh) {
    const pts = stops2.map((s) => [s.lat, s.lng]);
    const cum = cumMeters(pts);
    return stops2.map((s, i) => ({ ...s, cumMin: +((cum[i] / 1000 / speedKmh) * 60).toFixed(1) }));
  }
  const gayrettepe = (stationsRaw.find((s) => s.LineName === "M2" && s.Name === "GAYRETTEPE") || {}).DetailInfo;
  const m11stops = withCumMin([
    { name: "Gayrettepe", lat: gayrettepe ? +gayrettepe.Latitude : 41.0679, lng: gayrettepe ? +gayrettepe.Longitude : 29.0062 },
    { name: "Kağıthane", lat: 41.0854, lng: 28.9773 },
    { name: "Hasdal", lat: 41.0975, lng: 28.9418 },
    { name: "Kemerburgaz", lat: 41.1345, lng: 28.9163 },
    { name: "Göktürk", lat: 41.166, lng: 28.889 },
    { name: "İhsaniye", lat: 41.2094, lng: 28.8213 },
    { name: "İstanbul Havalimanı", lat: 41.2609, lng: 28.7444 },
  ], 75);
  const metrobusStops = withCumMin([
    { name: "Beylikdüzü Sondurak (TÜYAP)", lat: 41.0027, lng: 28.634 },
    { name: "Beylikdüzü Belediyesi", lat: 41.0011, lng: 28.6531 },
    { name: "Beykent", lat: 40.999, lng: 28.6624 },
    { name: "Haramidere", lat: 40.9915, lng: 28.6982 },
    { name: "Avcılar Merkez - Üniv. Kampüsü", lat: 40.98, lng: 28.7215 },
    { name: "Küçükçekmece", lat: 40.9899, lng: 28.7742 },
    { name: "Sefaköy", lat: 40.9925, lng: 28.8098 },
    { name: "Yenibosna", lat: 40.9977, lng: 28.8324 },
    { name: "Şirinevler", lat: 40.9995, lng: 28.8432 },
    { name: "İncirli", lat: 41.0045, lng: 28.858 },
    { name: "Zeytinburnu", lat: 41.0077, lng: 28.885 },
    { name: "Merter", lat: 41.0128, lng: 28.894 },
    { name: "Cevizlibağ", lat: 41.0186, lng: 28.9145 },
    { name: "Topkapı", lat: 41.0223, lng: 28.9227 },
    { name: "Edirnekapı", lat: 41.0334, lng: 28.933 },
    { name: "Ayvansaray", lat: 41.0387, lng: 28.9401 },
    { name: "Halıcıoğlu", lat: 41.0442, lng: 28.9482 },
    { name: "Okmeydanı", lat: 41.0512, lng: 28.9591 },
    { name: "Çağlayan", lat: 41.0577, lng: 28.9776 },
    { name: "Mecidiyeköy", lat: 41.0648, lng: 28.9932 },
    { name: "Zincirlikuyu", lat: 41.0679, lng: 29.0113 },
    { name: "15 Temmuz Şehitler Köprüsü", lat: 41.0459, lng: 29.034 },
    { name: "Burhaniye", lat: 41.0428, lng: 29.0448 },
    { name: "Altunizade", lat: 41.0225, lng: 29.043 },
    { name: "Uzunçayır", lat: 41.0062, lng: 29.0511 },
    { name: "Fikirtepe", lat: 40.9987, lng: 29.0455 },
    { name: "Söğütlüçeşme", lat: 40.9948, lng: 29.0368 },
  ], 32);
  const statics = [
    {
      key: "M11", kind: "metro", name: "M11", desc: "Gayrettepe – İstanbul Havalimanı",
      color: "#8e9093", firstTime: "06:00", lastTime: "00:00", schematic: true,
      path: m11stops.map((s) => [s.lat, s.lng]),
      durationMin: m11stops[m11stops.length - 1].cumMin,
      stations: m11stops,
      headways: [{ from: "06:00", to: "24:00", secs: 720 }],
    },
    {
      key: "34", kind: "metrobus", name: "Metrobüs", desc: "Beylikdüzü – Söğütlüçeşme (34)",
      color: "#b0332c", firstTime: "00:00", lastTime: "24:00", schematic: true,
      path: metrobusStops.map((s) => [s.lat, s.lng]),
      durationMin: metrobusStops[metrobusStops.length - 1].cumMin,
      stations: metrobusStops,
      headways: [
        { from: "00:00", to: "06:00", secs: 600 },
        { from: "06:00", to: "21:00", secs: 90 },
        { from: "21:00", to: "24:00", secs: 180 },
      ],
    },
  ];

  const out = {
    generatedAt: new Date().toISOString(),
    api: API,
    lines,
    marmaray,
    statics,
    ferries,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, "window.TRANSIT = " + JSON.stringify(out) + ";\n", { encoding: "utf8" });
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`WROTE ${OUT} (${kb} KB)`);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
