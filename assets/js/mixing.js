// Banner: three small porous-media simulations that tell the research story.
//   1. Mixing       - a solute invades a grain pack and stretches into fingers
//   2. Reaction     - A + B -> C along the front; dead-end pores become hotspots
//   3. Dissolution  - acid invades and dissolves rock pillars
// Each scene: pressure-driven flow through the pore space (SOR solve of the
// pressure equation, no-flux at grains), then conservative upwind
// advection-diffusion (+ reaction) of the concentrations.
(function () {
  var canvas = document.getElementById("mixing-canvas");
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext("2d");
  var tabs = [].slice.call(document.querySelectorAll(".scene-tab"));
  var caption = document.getElementById("scene-caption");
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var DURATION = [15, 17, 18];     // seconds per scene
  var SUB = 4;                     // transport sub-steps per frame
  var D = 0.06;                    // diffusion coefficient (cells^2 / sub-step)

  var NX, NY = 60, N, W, H;
  var solid, p, ux, uy, A, B, dA, dB, glow, mass, scale;
  var off = document.createElement("canvas"), offCtx = off.getContext("2d"), img;
  var scene = 0, t0 = 0, running = true, visible = true, started = !reduceMotion, gmax = 1e-6;

  // ---------- geometry ----------
  function idx(i, j) { return j * NX + i; }

  function stamp(cx, cy, r, val) {
    for (var j = Math.max(0, Math.floor(cy - r)); j <= Math.min(NY - 1, Math.ceil(cy + r)); j++)
      for (var i = Math.max(0, Math.floor(cx - r)); i <= Math.min(NX - 1, Math.ceil(cx + r)); i++) {
        var dx = i + 0.5 - cx, dy = j + 0.5 - cy;
        if (dx * dx + dy * dy <= r * r) solid[idx(i, j)] = val;
      }
  }

  function grainPack() {                       // dense, polydisperse grains
    var circles = [], tries = 0;
    while (tries++ < 9000) {
      var u = Math.random(), r = 1.3 + 3.2 * u * u;
      var c = { x: 4 + r + Math.random() * (NX - 7 - 2 * r), y: Math.random() * NY, r: r }, ok = true;
      for (var q = 0; q < circles.length; q++) {
        var o = circles[q], dx = o.x - c.x, dy = o.y - c.y, m = o.r + c.r + 1.3;
        if (dx * dx + dy * dy < m * m) { ok = false; break; }
      }
      if (ok) circles.push(c);
    }
    circles.forEach(function (c) { stamp(c.x, c.y, c.r, 1); });
  }

  function deadEndChannel() {                  // channel with dead-end pores
    solid.fill(1);
    var hw = NY * 0.1, amp = NY * 0.07, lam = NX / 2.3;
    function yc(x) { return NY / 2 + amp * Math.sin(2 * Math.PI * x / lam); }
    for (var i = 0; i < NX; i++) {
      var c = yc(i);
      for (var j = 0; j < NY; j++) if (Math.abs(j + 0.5 - c) < hw) solid[idx(i, j)] = 0;
    }
    var gap = NX / 8, side = 1;
    for (var x = gap * 0.9; x < NX - gap * 0.6; x += gap * (0.8 + Math.random() * 0.4)) {
      var w = 2.5 + Math.random() * 2.5, c2 = yc(x);
      var len = (NY / 2 - hw - 4) * (0.6 + Math.random() * 0.4);
      var y0 = c2 + side * (hw - 1), y1 = c2 + side * (hw + len);
      for (var jj = Math.floor(Math.min(y0, y1)); jj <= Math.ceil(Math.max(y0, y1)); jj++)
        for (var ii = Math.floor(x - w / 2); ii <= Math.ceil(x + w / 2); ii++)
          if (ii >= 0 && ii < NX && jj >= 0 && jj < NY) solid[idx(ii, jj)] = 0;
      if (Math.random() < 0.6) stamp(x, y1, w * 0.9 + 1.5, 0);   // some end in a round chamber
      side = -side;
    }
  }

  function pillars() {                          // rock pillars on a jittered lattice
    var s = NY / 5, r0 = s * 0.36;
    for (var col = 0, x = 7 + r0; x < NX - r0 - 2; x += s * 0.87, col++)
      for (var y = (col % 2 ? s / 2 : 0) + s / 2; y < NY + r0; y += s)
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
      uy[j * NX + i] = (!solid[k] && !solid[k - NX]) ? p[k - NX] - p[k] : 0;
    }
    if (setScale) {
      var target = NX / (0.55 * DURATION[scene] * 60 * SUB);   // front crosses in ~55% of the scene
      var mean = sum / Math.max(1, n);
      scale = Math.min(target / Math.max(mean, 1e-9), 0.42 / Math.max(mx, 1e-9));
    }
    for (i = 0; i < ux.length; i++) ux[i] = Math.max(-0.45, Math.min(0.45, ux[i] * scale));
    for (i = 0; i < uy.length; i++) uy[i] = Math.max(-0.45, Math.min(0.45, uy[i] * scale));
  }

  // ---------- transport ----------
  function transport(C, dC, cin) {
    dC.fill(0);
    var i, j, k, f, u, F;
    for (j = 0; j < NY; j++) {
      for (i = 0; i <= NX; i++) {
        f = j * (NX + 1) + i; u = ux[f];
        if (i === 0) {
          k = j * NX;
          if (solid[k]) continue;
          dC[k] += (u > 0 ? u * cin : u * C[k]) + D * (cin - C[k]);
        } else if (i === NX) {
          k = j * NX + NX - 1;
          if (!solid[k] && u > 0) dC[k] -= u * C[k];
        } else {
          k = j * NX + i;
          if (solid[k] || solid[k - 1]) continue;
          F = (u > 0 ? u * C[k - 1] : u * C[k]) + D * (C[k - 1] - C[k]);
          dC[k - 1] -= F; dC[k] += F;
        }
      }
    }
    for (j = 1; j < NY; j++) for (i = 0; i < NX; i++) {
      k = j * NX + i;
      if (solid[k] || solid[k - NX]) continue;
      u = uy[k];
      F = (u > 0 ? u * C[k - NX] : u * C[k]) + D * (C[k - NX] - C[k]);
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
    var changed = false;
    for (var j = 0; j < NY; j++) for (var i = 0; i < NX; i++) {
      var k = idx(i, j);
      glow[k] *= 0.9;
      if (!solid[k]) continue;
      var nb = [], acid = 0;
      if (i > 0 && !solid[k - 1]) nb.push(k - 1);
      if (i < NX - 1 && !solid[k + 1]) nb.push(k + 1);
      if (j > 0 && !solid[k - NX]) nb.push(k - NX);
      if (j < NY - 1 && !solid[k + NX]) nb.push(k + NX);
      for (var q = 0; q < nb.length; q++) acid += A[nb[q]];
      if (acid < 0.01) continue;
      var d = 0.022 * acid;
      mass[k] -= d; glow[k] += d * 6;
      for (q = 0; q < nb.length; q++) A[nb[q]] *= 0.82;        // acid is used up by the reaction
      if (mass[k] <= 0) {
        solid[k] = 0; mass[k] = 0; changed = true;
        var pa = 0; for (q = 0; q < nb.length; q++) pa += p[nb[q]];
        p[k] = pa / nb.length; A[k] = 0;
      }
    }
    if (changed) { sor(25); velocities(false); }
  }

  // ---------- drawing ----------
  function lerp3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function ramp(stops, t) {
    t = Math.max(0, Math.min(1, t)) * (stops.length - 1);
    var i = Math.min(stops.length - 2, Math.floor(t));
    return lerp3(stops[i], stops[i + 1], t - i);
  }
  var DARK = [11, 19, 30], GRAIN = [58, 68, 80];
  var MIX = [DARK, [14, 110, 122], [120, 205, 210], [236, 248, 248]];
  var HOT = [[0, 0, 0], [150, 20, 10], [235, 90, 20], [255, 200, 60], [255, 250, 220]];
  var ROCK = [196, 142, 98];

  function draw() {
    var d = img.data, k, c;
    if (scene === 1) {
      var m = 1e-9;
      for (k = 0; k < N; k++) if (glow[k] > m) m = glow[k];
      gmax = Math.max(m, gmax * 0.99);
    }
    for (k = 0; k < N; k++) {
      if (scene === 0) {
        c = solid[k] ? GRAIN : ramp(MIX, A[k]);
      } else if (scene === 1) {
        if (solid[k]) c = [34, 39, 46];
        else {
          c = lerp3(DARK, [40, 90, 170], A[k] * 0.55);
          c = lerp3(c, [24, 70, 60], B[k] * 0.45);
          var h = Math.sqrt(glow[k] / gmax);
          if (h > 0.04) { var hc = ramp(HOT, h); c = [Math.max(c[0], hc[0]), Math.max(c[1], hc[1]), Math.max(c[2], hc[2])]; }
        }
      } else {
        if (solid[k]) c = lerp3([70, 50, 38], ROCK, 0.35 + 0.65 * mass[k]);
        else c = lerp3(DARK, [80, 150, 255], A[k] * 0.75);
        var g = Math.min(1, glow[k] * 1.5);
        if (g > 0.03) c = lerp3(c, [255, 170, 60], g);
      }
      d[k * 4] = c[0]; d[k * 4 + 1] = c[1]; d[k * 4 + 2] = c[2]; d[k * 4 + 3] = 255;
    }
    offCtx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, W, H);
  }

  // ---------- scenes ----------
  function setup(s) {
    scene = s;
    NX = Math.max(80, Math.round(NY * W / H));
    N = NX * NY;
    solid = new Uint8Array(N); p = new Float32Array(N);
    ux = new Float32Array((NX + 1) * NY); uy = new Float32Array(NX * (NY + 1));
    A = new Float32Array(N); B = new Float32Array(N); dA = new Float32Array(N); dB = new Float32Array(N);
    glow = new Float32Array(N); mass = new Float32Array(N); gmax = 1e-6;
    off.width = NX; off.height = NY; img = offCtx.createImageData(NX, NY);

    if (s === 0) grainPack(); else if (s === 1) deadEndChannel(); else pillars();
    for (var i = 0; i < NX; i++) for (var j = 0; j < NY; j++) p[idx(i, j)] = 1 - (i + 0.5) / NX;
    sor(900);
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
  if (reduceMotion) { for (var s = 0; s < 260; s++) step(); }   // still picture of the mixing front
  draw();
  requestAnimationFrame(loop);
})();
