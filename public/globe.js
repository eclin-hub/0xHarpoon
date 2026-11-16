"use strict";
/* Globe terrestre interactif (projection orthographique d3 sur canvas) : rotation à la souris, zoom, points lumineux, clic sur un pays. */
const Globe = (() => {
  let world = null, loading = null;
  async function loadWorld() {
    if (world) return world;
    loading ||= (async () => {
      const raw = window.__WORLD__ || (await (await fetch("vendor/world.json")).json());
      const feats = topojson.feature(raw.topo, raw.topo.objects.countries).features;
      for (const f of feats) { const m = raw.meta[f.id] || raw.meta[String(f.id).padStart(3, "0")]; f.iso2 = m?.iso2 || null; f.nameFr = m?.fr || f.properties.name; f.centroid = d3.geoCentroid(f); }
      world = { names: Object.fromEntries(Object.values(raw.meta).filter((m) => m.iso2).map((m) => [m.iso2, m.fr])), feats, borders: topojson.mesh(raw.topo, raw.topo.objects.countries, (a, b) => a !== b), byIso: Object.fromEntries(feats.filter((f) => f.iso2).map((f) => [f.iso2, f])) };
      return world;
    })();
    return loading;
  }
  const KIND = { guerre: "#ff3d86", insurrection: "#ff8a3d", tension: "#ffc247", commerce: "#9a6bff" };

  function create(host, { onCountry, onPoint, onHover }) {
    const canvas = document.createElement("canvas"); canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", "Globe terrestre interactif"); canvas.style.cssText = "width:100%;display:block;touch-action:none;cursor:grab";
    host.replaceChildren(canvas);
    const ctx = canvas.getContext("2d"), proj = d3.geoOrthographic().clipAngle(90), path = d3.geoPath(proj, ctx), grat = d3.geoGraticule10();
    const st = { rot: [-25, -22, 0], zoom: 1, w: 0, h: 0, points: [], quakes: [], heat: {}, bloc: null, rel: null, arcs: [], sel: null, hover: null, hoverPt: null, auto: true, layers: { conflicts: true, quakes: true, heat: true }, t0: performance.now(), raf: 0, visible: true };
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    function size() { const w = host.clientWidth || 600, h = Math.min(Math.max(360, w * 0.82), 680), dpr = Math.min(2, window.devicePixelRatio || 1); st.w = w; st.h = h; canvas.width = w * dpr; canvas.height = h * dpr; canvas.style.height = h + "px"; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
    const visible = (lon, lat) => d3.geoDistance([lon, lat], [-st.rot[0], -st.rot[1]]) < Math.PI / 2 - 0.02;
    function draw(now) {
      if (!world || !st.w) return;
      const { w, h } = st, R = Math.min(w, h) / 2 * 0.92 * st.zoom, cx = w / 2, cy = h / 2, pulse = reduce ? 0.5 : ((now - st.t0) / 1800) % 1;
      proj.translate([cx, cy]).scale(R).rotate(st.rot); ctx.clearRect(0, 0, w, h);
      // halo et océan
      const halo = ctx.createRadialGradient(cx, cy, R * 0.92, cx, cy, R * 1.22); halo.addColorStop(0, "rgba(34,230,255,0.28)"); halo.addColorStop(1, "rgba(34,230,255,0)"); ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(cx, cy, R * 1.22, 0, 7); ctx.fill();
      const sea = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R); sea.addColorStop(0, "#12224a"); sea.addColorStop(1, "#060a1c"); ctx.fillStyle = sea; ctx.beginPath(); path({ type: "Sphere" }); ctx.fill();
      ctx.strokeStyle = "rgba(140,170,255,0.09)"; ctx.lineWidth = 0.6; ctx.beginPath(); path(grat); ctx.stroke();
      // pays
      for (const f of world.feats) {
        const hot = st.layers.heat ? st.heat[f.iso2] || 0 : 0;
        ctx.beginPath(); path(f);
        const blc = st.bloc && st.bloc.set.has(f.iso2), ally = st.rel?.allies.has(f.iso2), riv = st.rel?.rivals.has(f.iso2), side = st.rel?.sides?.[f.iso2];
        ctx.fillStyle = f === st.sel ? "rgba(34,230,255,0.55)" : f === st.hover ? "rgba(34,230,255,0.3)" : side ? side : ally ? "rgba(43,255,176,0.42)" : riv ? "rgba(255,61,134,0.42)" : blc ? st.bloc.fill : hot ? `rgba(255,${Math.round(150 - hot * 90)},${Math.round(134 - hot * 40)},${0.16 + hot * 0.4})` : "rgba(70,96,170,0.28)"; ctx.fill();
      }
      ctx.strokeStyle = "rgba(120,160,255,0.35)"; ctx.lineWidth = 0.5; ctx.beginPath(); path(world.borders); ctx.stroke();
      ctx.strokeStyle = "rgba(34,230,255,0.55)"; ctx.lineWidth = 1.2; ctx.beginPath(); path({ type: "Sphere" }); ctx.stroke();
      // liens animés (alliés, rivaux, soutiens)
      if (st.arcs.length) { ctx.save(); ctx.lineWidth = 1.7; ctx.setLineDash([7, 6]); ctx.lineDashOffset = reduce ? 0 : -((now / 45) % 13);
        for (const a of st.arcs) { ctx.strokeStyle = a.color; ctx.shadowColor = a.color; ctx.shadowBlur = 8; ctx.beginPath(); path({ type: "LineString", coordinates: [a.a, a.b] }); ctx.stroke(); }
        ctx.setLineDash([]); ctx.shadowBlur = 0;
        for (const a of st.arcs) for (const pt of [a.a, a.b]) { if (!visible(pt[0], pt[1])) continue; const [x, y] = proj(pt); ctx.fillStyle = a.color; ctx.beginPath(); ctx.arc(x, y, 2.6, 0, 7); ctx.fill(); }
        ctx.restore(); }
      // séismes
      st.scr = [];
      if (st.layers.quakes) for (const q of st.quakes) { if (!visible(q.lon, q.lat)) continue; const [x, y] = proj([q.lon, q.lat]), r = 2 + (q.mag - 5) * 3; ctx.strokeStyle = "rgba(255,194,71,0.85)"; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.stroke(); st.scr.push({ x, y, r: r + 4, d: q, type: "quake" }); }
      // foyers de tension : point lumineux et onde
      if (st.layers.conflicts) for (const c of st.points) {
        if (!visible(c.lon, c.lat)) continue; const [x, y] = proj([c.lon, c.lat]), col = KIND[c.kind] || "#fff", base = 3 + c.level * 1.6, act = c === st.hoverPt || c === st.selPt;
        ctx.strokeStyle = col; ctx.globalAlpha = (1 - pulse) * 0.8; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, base + pulse * (10 + c.level * 6), 0, 7); ctx.stroke(); ctx.globalAlpha = 1;
        ctx.shadowColor = col; ctx.shadowBlur = act ? 26 : 14; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, act ? base + 2 : base, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
        ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(x, y, 1.4, 0, 7); ctx.fill();
        if (act || (c.level === 3 && st.zoom >= 1)) { ctx.font = "600 11px Manrope, sans-serif"; ctx.fillStyle = "rgba(232,236,255,0.95)"; ctx.shadowColor = "#000"; ctx.shadowBlur = 6; ctx.fillText(c.name, x + base + 6, y + 4); ctx.shadowBlur = 0; }
        st.scr.push({ x, y, r: base + 8, d: c, type: "conflict" });
      }
    }
    function loop(now) { if (st.auto && !reduce) st.rot[0] += 0.05; draw(now); st.raf = st.visible ? requestAnimationFrame(loop) : 0; }
    function start() { st.visible = true; if (!st.raf) st.raf = requestAnimationFrame(loop); }
    function stop() { st.visible = false; cancelAnimationFrame(st.raf); st.raf = 0; }
    const pos = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    function pick(x, y) {
      const p = (st.scr || []).filter((s) => Math.hypot(s.x - x, s.y - y) <= s.r).sort((a, b) => (a.type === "conflict" ? 0 : 1) - (b.type === "conflict" ? 0 : 1))[0]; if (p) return { point: p };
      const ll = proj.invert([x, y]); if (!ll || !visible(ll[0], ll[1])) return {};
      return { country: world.feats.find((f) => d3.geoContains(f, ll)) || null };
    }
    let drag = null, moved = false, lastHover = 0;
    canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, rot: [...st.rot] }; moved = false; st.auto = false; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = "grabbing"; });
    canvas.addEventListener("pointermove", (e) => {
      if (drag) { const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 4) moved = true; const k = 0.28 / st.zoom; st.rot = [drag.rot[0] + dx * k, Math.max(-80, Math.min(80, drag.rot[1] - dy * k)), 0]; return; }
      if (performance.now() - lastHover < 60 || !world) return; lastHover = performance.now();
      const [x, y] = pos(e), hit = pick(x, y); st.hoverPt = hit.point?.type === "conflict" ? hit.point.d : null; st.hover = hit.point ? null : hit.country || null; canvas.style.cursor = hit.point || hit.country ? "pointer" : "grab";
      onHover && onHover(e, hit.point ? hit.point : hit.country ? { type: "country", d: hit.country } : null);
    });
    canvas.addEventListener("pointerup", (e) => { canvas.style.cursor = "grab"; const was = drag; drag = null; if (!was || moved || !world) return; const [x, y] = pos(e), hit = pick(x, y);
      if (hit.point?.type === "conflict") { st.selPt = hit.point.d; onPoint && onPoint(hit.point.d); } else if (hit.point) onPoint && onPoint(hit.point.d, "quake"); else if (hit.country) { st.sel = hit.country; st.selPt = null; onCountry && onCountry(hit.country); } });
    canvas.addEventListener("pointerleave", () => { st.hover = null; st.hoverPt = null; onHover && onHover(null, null); });
    canvas.addEventListener("wheel", (e) => { e.preventDefault(); st.auto = false; st.zoom = Math.max(0.7, Math.min(4, st.zoom * (e.deltaY < 0 ? 1.12 : 0.89))); }, { passive: false });
    new ResizeObserver(size).observe(host); size();
    loadWorld().then(() => start());
    function flyTo(lon, lat, zoom) {
      st.auto = false; const from = [...st.rot], to = [-lon, -lat, 0]; let d = to[0] - from[0]; d = ((d + 540) % 360) - 180; const z0 = st.zoom, z1 = zoom || st.zoom, t0 = performance.now(), dur = reduce ? 1 : 900;
      const step = (t) => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); st.rot = [from[0] + d * e, from[1] + (to[1] - from[1]) * e, 0]; st.zoom = z0 + (z1 - z0) * e; if (k < 1) requestAnimationFrame(step); }; requestAnimationFrame(step);
    }
    return {
      set({ points, quakes, heat }) { if (points) st.points = points; if (quakes) st.quakes = quakes; if (heat) st.heat = heat; },
      overlay({ bloc, rel, arcs }) { if (bloc !== undefined) st.bloc = bloc; if (rel !== undefined) st.rel = rel; if (arcs !== undefined) st.arcs = arcs || []; },
      pt(iso) { const p = GEO.PIN[iso]; if (p) return p; const f = world?.byIso[iso]; return f ? f.centroid : null; }, clearSel() { st.sel = null; st.selPt = null; },
      layers(l) { Object.assign(st.layers, l); }, flyTo, start, stop,
      select(iso) { const f = world?.byIso[iso]; if (f) { st.sel = f; flyTo(f.centroid[0], f.centroid[1], Math.max(st.zoom, 1.5)); } return f; },
      selectPoint(c) { st.selPt = c; st.sel = null; flyTo(c.lon, c.lat, Math.max(st.zoom, 1.6)); }, zoom(k) { st.auto = false; st.zoom = Math.max(0.7, Math.min(4, st.zoom * k)); }, spin(on) { st.auto = on; },
      world: () => world,
    };
  }
  return { create, loadWorld, KIND };
})();
