// Banner: three small porous-media simulations that tell the research story.
//   1. Mixing       - a solute invades a grain pack and stretches into fingers
//   2. Reaction     - A + B -> C along the front; dead-end pores become hotspots
//   3. Dissolution  - acid invades and dissolves rock pillars
// Each scene: pressure-driven flow through the pore space (SOR solve of the
// pressure equation, no-flux at grains), then conservative advection-diffusion
// (+ reaction) with a second-order TVD scheme (van Leer limiter).
(function () {
  var canvas = document.getElementById("mixing-canvas");
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext("2d");
  var tabs = [].slice.call(document.querySelectorAll(".scene-tab"));
  var caption = document.getElementById("scene-caption");
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var DURATION = [15, 18, 18];     // seconds per scene
  var DIFF = [0.012, 0.05, 0.02];  // diffusion per scene (cells^2 / sub-step)
  var SUB = 4;                     // transport sub-steps per frame
  var UP = 2;                      // render resolution = UP x grid

  var NX, NY = 72, N, W, H, D;
  var solid, p, ux, uy, A, B, dA, dB, glow, mass, scale;
  var off = document.createElement("canvas"), offCtx = off.getContext("2d"), img;
  var scene = 0, t0 = 0, visible = true, started = !reduceMotion, gmax = 1e-6;

  // ---------- geometry ----------
  function idx(i, j) { return j * NX + i; }

  function stamp(cx, cy, r, val) {
    for (var j = Math.max(0, Math.floor(cy - r)); j <= Math.min(NY - 1, Math.ceil(cy + r)); j++)
      for (var i = Math.max(0, Math.floor(cx - r)); i <= Math.min(NX - 1, Math.ceil(cx + r)); i++) {
        var dx = i + 0.5 - cx, dy = j + 0.5 - cy;
        if (dx * dx + dy * dy <= r * r) solid[idx(i, j)] = val;
      }
  }

  function scatter(x0, x1, y0, y1, rmin, rmax, gap, tries) {   // random non-overlapping grains
    var circles = [];
    while (tries-- > 0) {
      var u = Math.random(), r = rmin + (rmax - rmin) * u * u;
      var c = { x: x0 + Math.random() * (x1 - x0), y: y0 + Math.random() * (y1 - y0), r: r }, ok = true;
      for (var q = 0; q < circles.length; q++) {
        var o = circles[q], dx = o.x - c.x, dy = o.y - c.y, m = o.r + c.r + gap;
        if (dx * dx + dy * dy < m * m) { ok = false; break; }
      }
      if (ok) circles.push(c);
    }
    circles.forEach(function (c) { stamp(c.x, c.y, c.r, 1); });
  }

  function grainPack() {
    scatter(5, NX - 3, -2, NY + 2, 1.6, 4.8, 1.4, 12000);
  }

  function deadEndPores() {                     // porous band + dead-end pores in the walls
    solid.fill(1);
    var top = NY * 0.3, bot = NY * 0.7;
    for (var j = Math.floor(top); j < Math.ceil(bot); j++) for (var i = 0; i < NX; i++) solid[idx(i, j)] = 0;
    scatter(6, NX - 3, top + 1, bot - 1, 1.6, 3.2, 1.6, 6000);
    var gap = NY * 0.55, side = Math.random() < 0.5 ? 1 : -1;
    for (var x = gap * 0.8; x < NX - gap * 0.4; x += gap * (0.75 + Math.random() * 0.5)) {
      var w = 2.6 + Math.random() * 2.2;
      var wall = side > 0 ? bot : top;
      var len = (NY * 0.3 - 3) * (0.55 + Math.random() * 0.45);
      var y0 = wall - side * 1, y1 = wall + side * len;
      for (var jj = Math.floor(Math.min(y0, y1)); jj <= Math.ceil(Math.max(y0, y1)); jj++)
        for (var ii = Math.floor(x - w / 2); ii <= Math.ceil(x + w / 2); ii++)
          if (ii >= 0 && ii < NX && jj >= 0 && jj < NY) solid[idx(ii, jj)] = 0;
      if (Math.random() < 0.55) stamp(x, y1, w * 0.8 + 1.6, 0);   // some end in a round chamber
      side = -side;
    }
  }

  function pillars() {                          // rock pillars on a jittered lattice
    var s = NY / 5, r0 = s * 0.36;
    for (var col = 0, x = 7 + r0; x < NX - r0 - 2; x += s * 0.87, col++)
      for (var y = (col % 2 ? s / 2 : 0) + s / 2 - s; y < NY + r0; y += s)
        stamp(x + (Math.random() - 0.5) * 1.5, y + (Math.random() - 0.5) * 1.5, r0 * (0.85 + Math.random() * 0.3), 1);
    for (var k = 0; k < N; k++) mass[k] = solid[k] ? 1 : 0;
  }

  // ---------- flow ----------
  function sor(iters) {
    for (var it = 0; it < iters; it++)
      for (var j = 0; j < NY; j++) for (var i = 0; i < NX; i++) {
        var k = j * NX + i;
        if (solid[k]) continue;
        var s = 0, w = 0;
        if (i === 0) { s += 1; w++; } else if (!solid[k - 1]) { s += p[k - 1]; w++; }
        if (i === NX - 1) { w++; } else if (!solid[k + 1]) { s += p[k + 1]; w++; }
        if (j > 0 && !solid[k - NX]) { s += p[k - NX]; w++; }
        if (j < NY - 1 && !solid[k + NX]) { s += p[k + NX]; w++; }
        if (w) p[k] += 1.9 * (s / w - p[k]);
      }
  }

  function velocities(setScale) {
    var i, j, k, sum = 0, n = 0, mx = 0;
    for (j = 0; j < NY; j++) for (i = 0; i <= NX; i++) {
      var f = j * (NX + 1) + i, u = 0;
      if (i === 0) { k = idx(0, j); if (!solid[k]) u = 1 - p[k]; }
      else if (i === NX) { k = idx(NX - 1, j); if (!solid[k]) u = p[k]; }
      else { k = idx(i, j); if (!solid[k] && !solid[k - 1]) { u = p[k - 1] - p[k]; sum += Math.abs(u); n++; } }
      ux[f] = u; if (Math.abs(u) > mx) mx = Math.abs(u);
    }
    for (j = 1; j < NY; j++) for (i = 0; i < NX; i++) {
      k = idx(i, j);
      uy[k] = (!solid[k] && !solid[k - NX]) ? p[k - NX] - p[k] : 0;
    }
    if (setScale) {
      var target = NX / (0.55 * DURATION[scene] * 60 * SUB);   // front crosses in ~55% of the scene
      scale = Math.min(target / Math.max(sum / Math.max(1, n), 1e-9), 0.4 / Math.max(mx, 1e-9));
    }
    for (i = 0; i < ux.length; i++) ux[i] = Math.max(-0.4, Math.min(0.4, ux[i] * scale));
    for (i = 0; i < uy.length; i++) uy[i] = Math.max(-0.4, Math.min(0.4, uy[i] * scale));
  }

  // ---------- transport ----------
  // value of C on a face, upwind cell cu, downwind cd, far-upwind cuu (van Leer limiter)
  function face(cu, cd, cuu) {
    var dd = cd - cu;
    if (dd > -1e-9 && dd < 1e-9) return cu;
    var r = (cu - cuu) / dd, ar = r < 0 ? -r : r;
    return cu + 0.5 * (r + ar) / (1 + ar) * dd;
  }

  function transport(C, dC, cin) {
    dC.fill(0);
    var i, j, k, u, F, cuu;
    for (j = 0; j < NY; j++) {
      var row = j * NX;
      // inlet (first order)
      k = row;
      if (!solid[k]) { u = ux[j * (NX + 1)]; dC[k] += (u > 0 ? u * cin : u * C[k]) + D * (cin - C[k]); }
      for (i = 1; i < NX; i++) {
        k = row + i;
        if (solid[k] || solid[k - 1]) continue;
        u = ux[j * (NX + 1) + i];
        if (u > 0) { cuu = (i > 1 && !solid[k - 2]) ? C[k - 2] : C[k - 1]; F = u * face(C[k - 1], C[k], cuu); }
        else if (u < 0) { cuu = (i < NX - 1 && !solid[k + 1]) ? C[k + 1] : C[k]; F = u * face(C[k], C[k - 1], cuu); }
        else F = 0;
        F += D * (C[k - 1] - C[k]);
        dC[k - 1] -= F; dC[k] += F;
      }
      k = row + NX - 1;                                     // outlet
      u = ux[j * (NX + 1) + NX];
      if (!solid[k] && u > 0) dC[k] -= u * C[k];
    }
    for (j = 1; j < NY; j++) for (i = 0; i < NX; i++) {
      k = j * NX + i;
      if (solid[k] || solid[k - NX]) continue;
      u = uy[k];
      if (u > 0) { cuu = (j > 1 && !solid[k - 2 * NX]) ? C[k - 2 * NX] : C[k - NX]; F = u * face(C[k - NX], C[k], cuu); }
      else if (u < 0) { cuu = (j < NY - 1 && !solid[k + NX]) ? C[k + NX] : C[k]; F = u * face(C[k], C[k - NX], cuu); }
      else F = 0;
      F += D * (C[k - NX] - C[k]);
      dC[k - NX] -= F; dC[k] += F;
    }
    for (k = 0; k < N; k++) {
      if (solid[k]) { C[k] = 0; continue; }
      var v = C[k] + dC[k];
      C[k] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
  }

  function step() {
    for (var s = 0; s < SUB; s++) {
      transport(A, dA, 1);
      if (scene === 1) {
        transport(B, dB, 0);
        for (var k = 0; k < N; k++) {
          if (solid[k]) continue;
          var r = 0.35 * A[k] * B[k];
          A[k] -= r; B[k] -= r;
          glow[k] = glow[k] * 0.985 + r;
        }
      }
    }
    if (scene === 2) dissolve();
  }

  function dissolve() {
    var changed = false, nb = [0, 0, 0, 0];
    for (var j = 0; j < NY; j++) for (var i = 0; i < NX; i++) {
      var k = idx(i, j);
      glow[k] *= 0.9;
      if (!solid[k]) continue;
      var n = 0, acid = 0;
      if (i > 0 && !solid[k - 1]) nb[n++] = k - 1;
      if (i < NX - 1 && !solid[k + 1]) nb[n++] = k + 1;
      if (j > 0 && !solid[k - NX]) nb[n++] = k - NX;
      if (j < NY - 1 && !solid[k + NX]) nb[n++] = k + NX;
      for (var q = 0; q < n; q++) acid += A[nb[q]];
      if (acid < 0.01) continue;
      var d = 0.04 * acid;
      mass[k] -= d; glow[k] += d * 5;
      for (q = 0; q < n; q++) A[nb[q]] *= 0.86;               // acid is used up by the reaction
      if (mass[k] <= 0) {
        solid[k] = 0; mass[k] = 0; changed = true;
        var pa = 0; for (q = 0; q < n; q++) pa += p[nb[q]];
        p[k] = pa / n; A[k] = 0;
      }
    }
    if (changed) { sor(25); velocities(false); }
  }

  // ---------- drawing ----------
  function lut(stops) {                         // 256-entry colour ramp
    var t = new Uint8ClampedArray(256 * 3);
    for (var q = 0; q < 256; q++) {
      var x = q / 255 * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
      for (var c = 0; c < 3; c++) t[q * 3 + c] = stops[i][c] + (stops[i + 1][c] - stops[i][c]) * f;
    }
    return t;
  }
  var DARK = [11, 19, 30];
  var MIX = lut([DARK, [14, 110, 122], [120, 205, 210], [236, 248, 248]]);
  var HOT = lut([[0, 0, 0], [150, 20, 10], [235, 90, 20], [255, 200, 60], [255, 250, 220]]);
  var SOLID = [[58, 68, 80], [36, 42, 50], [196, 142, 98]];
  var ks = new Int32Array(4), ws = new Float32Array(4);

  function draw() {
    var d = img.data, OW = NX * UP, OH = NY * UP;
    if (scene === 1) {
      var m = 1e-9;
      for (var k0 = 0; k0 < N; k0++) if (glow[k0] > m) m = glow[k0];
      gmax = Math.max(m, gmax * 0.99);
    }
    for (var y = 0; y < OH; y++) {
      var gy = (y + 0.5) / UP - 0.5, j0 = Math.floor(gy), fy = gy - j0;
      if (j0 < 0) { j0 = 0; fy = 0; } if (j0 >= NY - 1) { j0 = NY - 2; fy = 1; }
      for (var x = 0; x < OW; x++) {
        var gx = (x + 0.5) / UP - 0.5, i0 = Math.floor(gx), fx = gx - i0;
        if (i0 < 0) { i0 = 0; fx = 0; } if (i0 >= NX - 1) { i0 = NX - 2; fx = 1; }
        var k = j0 * NX + i0;
        ks[0] = k; ks[1] = k + 1; ks[2] = k + NX; ks[3] = k + NX + 1;
        ws[0] = (1 - fx) * (1 - fy); ws[1] = fx * (1 - fy); ws[2] = (1 - fx) * fy; ws[3] = fx * fy;
        // solid fraction (dissolving rock counts by its remaining mass) and fluid-weighted fields
        var sf = 0, fw = 0, a = 0, b = 0, g = 0, ms = 0;
        for (var q = 0; q < 4; q++) {
          var kk = ks[q], w = ws[q];
          if (solid[kk]) { var sv = scene === 2 ? mass[kk] : 1; sf += w * sv; ms += w * mass[kk]; }
          else { fw += w; a += w * A[kk]; b += w * B[kk]; }
          g += w * glow[kk];
        }
        if (fw > 0) { a /= fw; b /= fw; }
        var r, gr, bl, o = (y * OW + x) * 4;
        if (scene === 0) {
          var mi = Math.round(a * 255) * 3; r = MIX[mi]; gr = MIX[mi + 1]; bl = MIX[mi + 2];
        } else if (scene === 1) {
          r = DARK[0] + (40 - DARK[0]) * a * 0.55; gr = DARK[1] + (90 - DARK[1]) * a * 0.55; bl = DARK[2] + (170 - DARK[2]) * a * 0.55;
          r += (24 - r) * b * 0.45; gr += (70 - gr) * b * 0.45; bl += (60 - bl) * b * 0.45;
          var h = Math.sqrt(g / gmax);
          if (h > 0.04) { var hi = Math.round(Math.min(1, h) * 255) * 3; r = Math.max(r, HOT[hi]); gr = Math.max(gr, HOT[hi + 1]); bl = Math.max(bl, HOT[hi + 2]); }
        } else {
          r = DARK[0] + (80 - DARK[0]) * a * 0.75; gr = DARK[1] + (150 - DARK[1]) * a * 0.75; bl = DARK[2] + (255 - DARK[2]) * a * 0.75;
        }
        // blend in the grain with a soft (anti-aliased) edge
        var alpha = Math.max(0, Math.min(1, (sf - 0.35) / 0.3));
        if (alpha > 0) {
          var sc = SOLID[scene], sr = sc[0], sg = sc[1], sb = sc[2];
          if (scene === 2) { var t = 0.45 + 0.55 * Math.min(1, ms / Math.max(sf, 1e-6)); sr *= t; sg *= t; sb *= t; }
          r += (sr - r) * alpha; gr += (sg - gr) * alpha; bl += (sb - bl) * alpha;
        }
        if (scene === 2 && g > 0.02) { var gg = Math.min(1, g * 1.6); r += (255 - r) * gg; gr += (170 - gr) * gg; bl += (60 - bl) * gg; }
        d[o] = r; d[o + 1] = gr; d[o + 2] = bl; d[o + 3] = 255;
      }
    }
    offCtx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(off, 0, 0, W, H);
  }

  // ---------- scenes ----------
  function setup(s) {
    scene = s; D = DIFF[s];
    NX = Math.max(90, Math.round(NY * W / H));
    N = NX * NY;
    solid = new Uint8Array(N); p = new Float32Array(N);
    ux = new Float32Array((NX + 1) * NY); uy = new Float32Array(N);
    A = new Float32Array(N); B = new Float32Array(N); dA = new Float32Array(N); dB = new Float32Array(N);
    glow = new Float32Array(N); mass = new Float32Array(N); gmax = 1e-6;
    off.width = NX * UP; off.height = NY * UP; img = offCtx.createImageData(NX * UP, NY * UP);

    if (s === 0) grainPack(); else if (s === 1) deadEndPores(); else pillars();
    for (var i = 0; i < NX; i++) for (var j = 0; j < NY; j++) p[idx(i, j)] = 1 - (i + 0.5) / NX;
    sor(1000);
    velocities(true);
    if (s === 1) for (var k = 0; k < N; k++) B[k] = solid[k] ? 0 : 1;

    tabs.forEach(function (tb, q) {
      tb.classList.toggle("active", q === s);
      tb.setAttribute("aria-selected", q === s ? "true" : "false");
      tb.querySelector("i").style.width = "0%";
    });
    if (caption && tabs[s]) caption.textContent = tabs[s].getAttribute("data-caption");
    t0 = performance.now();
  }

  function resize() {
    W = canvas.clientWidth; H = canvas.clientHeight;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function loop(now) {
    if (visible && started) {
      var el = (now - t0) / 1000;
      if (el > DURATION[scene]) { setup((scene + 1) % 3); el = 0; }
      step(); draw();
      var bar = tabs[scene] && tabs[scene].querySelector("i");
      if (bar) bar.style.width = Math.min(100, el / DURATION[scene] * 100) + "%";
    }
    requestAnimationFrame(loop);
  }

  function start() { if (!started) { started = true; t0 = performance.now(); } }

  tabs.forEach(function (tb, q) {
    tb.addEventListener("click", function () { start(); setup(q); draw(); });
  });
  canvas.addEventListener("click", function () { start(); setup(scene); draw(); });
  if (reduceMotion) canvas.addEventListener("pointerenter", start);

  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (e) { visible = e[0].isIntersecting; }).observe(canvas);
  }
  var rt;
  window.addEventListener("resize", function () {
    clearTimeout(rt);
    rt = setTimeout(function () { var oldW = W; resize(); if (Math.abs(W - oldW) > 40) setup(scene); draw(); }, 250);
  });

  resize(); setup(0);
  if (reduceMotion) { for (var s = 0; s < 300; s++) step(); }   // still picture of the mixing front
  draw();
  requestAnimationFrame(loop);
})();
