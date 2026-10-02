// Banner: three small porous-media simulations that tell the research story.
//   1. Mixing       - a solute invades a grain pack; the front breaks into fingers
//   2. Reaction     - Stokes flow past dead-end pores (recirculating eddies);
//                     A + B -> C glows where they meet, DEPs become hotspots
//   3. Dissolution  - acid invades and slowly dissolves rock pillars
// Flow: scenes 1 & 3 solve the pressure equation in the pore space (Darcy-like,
// no-flux at grains); scene 2 solves Stokes flow (stream function - vorticity).
// Transport: conservative advection-diffusion, second-order TVD (van Leer).
(function () {
  var canvas = document.getElementById("mixing-canvas");
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext("2d");
  var tabs = [].slice.call(document.querySelectorAll(".scene-tab"));
  var caption = document.getElementById("scene-caption");
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var DURATION = [16, 20, 20];      // seconds per scene
  var CROSS = [0.6, 0.45, 0.7];     // fraction of the scene the front needs to cross the domain
  var DIFF = [0.004, 0.03, 0.02];   // diffusion (cells^2 / sub-step)
  var SUB = 4;                      // transport sub-steps per frame
  var UP = 2;                       // render resolution = UP x grid
  var KDISS = 0.0065;               // dissolution rate (rock mass / frame / unit acid)

  var NX, NY = 72, N, W, H, D;
  var solid, p, ux, uy, A, B, dA, dB, glow, mass, scale, comp;
  var tracers = [], circles = [];
  var off = document.createElement("canvas"), offCtx = off.getContext("2d"), img;
  var scene = 0, t0 = 0, visible = true, started = !reduceMotion, gmax = 1e-6;
  var ks = new Int32Array(4), ws = new Float32Array(4);

  function idx(i, j) { return j * NX + i; }

  // ---------- geometry ----------
  function stamp(cx, cy, r, val) {
    for (var j = Math.max(0, Math.floor(cy - r)); j <= Math.min(NY - 1, Math.ceil(cy + r)); j++)
      for (var i = Math.max(0, Math.floor(cx - r)); i <= Math.min(NX - 1, Math.ceil(cx + r)); i++) {
        var dx = i + 0.5 - cx, dy = j + 0.5 - cy;
        if (dx * dx + dy * dy <= r * r) solid[idx(i, j)] = val;
      }
  }

  function grainPack() {                         // dense, polydisperse grains (as in the GIF)
    var tries = 14000;
    while (tries-- > 0) {
      var u = Math.random(), r = 1.4 + 4.6 * u * u * u;
      var c = { x: 5 + Math.random() * (NX - 8), y: -3 + Math.random() * (NY + 6), r: r }, ok = true;
      for (var q = 0; q < circles.length; q++) {
        var o = circles[q], dx = o.x - c.x, dy = o.y - c.y, m = o.r + c.r + 1.25;
        if (dx * dx + dy * dy < m * m) { ok = false; break; }
      }
      if (ok) circles.push(c);
    }
    circles.forEach(function (c) { stamp(c.x, c.y, c.r, 1); });
  }

  function deadEndPores() {                      // wavy channel + kidney-shaped dead-end pores
    solid.fill(1);
    var ph1 = Math.random() * 6, ph2 = Math.random() * 6;
    function centre(x) { return NY * 0.5 + NY * 0.07 * Math.sin(2 * Math.PI * x / (NX * 0.55) + ph1); }
    function half(x) { return NY * 0.15 + NY * 0.04 * Math.sin(2 * Math.PI * x / (NX * 0.33) + ph2); }
    for (var i = 0; i < NX; i++) {
      var c = centre(i + 0.5), h = half(i + 0.5);
      for (var j = 0; j < NY; j++) if (Math.abs(j + 0.5 - c) < h) solid[idx(i, j)] = 0;
    }
    var spacing = Math.max(26, NX / 5.5), side = Math.random() < 0.5 ? -1 : 1;
    for (var x = spacing * 0.7; x < NX - spacing * 0.5; x += spacing * (0.8 + Math.random() * 0.4)) {
      var wallY = centre(x) + side * half(x);
      var tilt = (Math.random() - 0.5) * 1.2, bend = (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 0.6);
      var len = NY * (0.16 + Math.random() * 0.06), steps = 14;
      for (var s = 0; s <= steps; s++) {           // a curved chain of circles: neck, then a fat body
        var f = s / steps;
        var px = x + tilt * f * len + bend * Math.sin(f * Math.PI) * len * 0.35;
        var py = wallY + side * (f * len - 1);
        var r = f < 0.2 ? NY * 0.06 : NY * 0.06 + (NY * 0.05) * Math.sin(Math.min(1, (f - 0.2) / 0.8) * Math.PI * 0.85);
        py = Math.max(r + 2.5, Math.min(NY - r - 2.5, py));
        stamp(px, py, r, 0);
      }
      side = -side;
    }
    // label the two walls (stream function is constant on each)
    comp = new Uint8Array(N);
    var stack = [];
    for (i = 0; i < NX; i++) if (solid[i]) { comp[i] = 1; stack.push(i); }
    while (stack.length) {
      var k = stack.pop(), ci = k % NX, cj = (k / NX) | 0;
      var nb = [ci > 0 ? k - 1 : -1, ci < NX - 1 ? k + 1 : -1, cj > 0 ? k - NX : -1, cj < NY - 1 ? k + NX : -1];
      for (var q = 0; q < 4; q++) { var n = nb[q]; if (n >= 0 && solid[n] && !comp[n]) { comp[n] = 1; stack.push(n); } }
    }
    for (k = 0; k < N; k++) if (solid[k] && !comp[k]) comp[k] = 2;
  }

  function cover(cx, cy, r) {                    // fraction of each cell covered by a pillar
    for (var j = Math.max(0, Math.floor(cy - r - 1)); j <= Math.min(NY - 1, Math.ceil(cy + r)); j++)
      for (var i = Math.max(0, Math.floor(cx - r - 1)); i <= Math.min(NX - 1, Math.ceil(cx + r)); i++) {
        var n = 0;
        for (var sy = 0; sy < 4; sy++) for (var sx = 0; sx < 4; sx++) {
          var dx = i + (sx + 0.5) / 4 - cx, dy = j + (sy + 0.5) / 4 - cy;
          if (dx * dx + dy * dy <= r * r) n++;
        }
        var k = idx(i, j);
        if (n / 16 > mass[k]) mass[k] = n / 16;
      }
  }

  function pillars() {                           // rock pillars on a jittered lattice
    var s = NY / 5, r0 = s * 0.36;
    for (var col = 0, x = 7 + r0; x < NX - r0 - 2; x += s * 0.87, col++)
      for (var y = (col % 2 ? s / 2 : 0) + s / 2 - s; y < NY + r0; y += s)
        cover(x + (Math.random() - 0.5) * 1.5, y + (Math.random() - 0.5) * 1.5, r0 * (0.85 + Math.random() * 0.3));
    for (var k = 0; k < N; k++) solid[k] = mass[k] > 0.5 ? 1 : 0;
  }

  // ---------- flow: pressure (scenes 1 and 3) ----------
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

  function pressureVelocities() {
    var i, j, k;
    for (j = 0; j < NY; j++) for (i = 0; i <= NX; i++) {
      var f = j * (NX + 1) + i, u = 0;
      if (i === 0) { k = idx(0, j); if (!solid[k]) u = 1 - p[k]; }
      else if (i === NX) { k = idx(NX - 1, j); if (!solid[k]) u = p[k]; }
      else { k = idx(i, j); if (!solid[k] && !solid[k - 1]) u = p[k - 1] - p[k]; }
      ux[f] = u;
    }
    for (j = 1; j < NY; j++) for (i = 0; i < NX; i++) {
      k = idx(i, j);
      uy[k] = (!solid[k] && !solid[k - NX]) ? p[k - NX] - p[k] : 0;
    }
  }

  // ---------- flow: Stokes via stream function / vorticity (scene 2) ----------
  // psi, omega live on cell corners (NX+1) x (NY+1); psi = 0 on the top wall,
  // 1 on the bottom wall, Poiseuille profile at inlet/outlet; Thom wall vorticity.
  function stokes() {
    var NXn = NX + 1, NYn = NY + 1, M = NXn * NYn;
    var psi = new Float32Array(M), om = new Float32Array(M), type = new Uint8Array(M);   // 0 interior, 1 wall, 2 fixed
    function cellComp(i, j) {
      if (j < 0) return 1; if (j >= NY) return 2;
      if (i < 0) i = 0; if (i >= NX) i = NX - 1;
      var k = idx(i, j); return solid[k] ? comp[k] : 0;
    }
    var i, j, n, q;
    for (j = 0; j < NYn; j++) for (i = 0; i < NXn; i++) {
      n = j * NXn + i;
      var c = [cellComp(i - 1, j - 1), cellComp(i, j - 1), cellComp(i - 1, j), cellComp(i, j)];
      var wall = 0;
      for (q = 0; q < 4; q++) if (c[q]) wall = c[q];
      if (wall) { type[n] = 1; psi[n] = wall === 1 ? 0 : 1; }
    }
    // inlet / outlet: Poiseuille profile across the open part of the column
    [0, NX].forEach(function (ci) {
      var col = ci === 0 ? 0 : NX - 1, top = -1, bot = -1;
      for (var jj = 0; jj < NY; jj++) if (!solid[idx(col, jj)]) { if (top < 0) top = jj; bot = jj + 1; }
      for (jj = 0; jj < NYn; jj++) {
        var nn = jj * NXn + ci, s = Math.max(0, Math.min(1, (jj - top) / Math.max(1, bot - top)));
        psi[nn] = 3 * s * s - 2 * s * s * s; type[nn] = 2;
        om[nn] = -(6 - 12 * s) / Math.pow(Math.max(1, bot - top), 2);
      }
    });
    // initial guess: linear between the walls along each column
    for (i = 1; i < NX; i++) {
      var tp = -1, bt = -1;
      for (j = 0; j < NYn; j++) { n = j * NXn + i; if (type[n] === 0) { if (tp < 0) tp = j; bt = j; } }
      for (j = tp; j <= bt && tp >= 0; j++) { n = j * NXn + i; if (type[n] === 0) psi[n] = (j - tp + 1) / (bt - tp + 2); }
    }
    var inner = [], walls = [];
    for (n = 0; n < M; n++) {
      if (type[n] === 0) inner.push(n);
      else if (type[n] === 1) {
        var ii = n % NXn, jj2 = (n / NXn) | 0, adj = [];
        if (ii > 0 && type[n - 1] === 0) adj.push(n - 1);
        if (ii < NXn - 1 && type[n + 1] === 0) adj.push(n + 1);
        if (jj2 > 0 && type[n - NXn] === 0) adj.push(n - NXn);
        if (jj2 < NYn - 1 && type[n + NXn] === 0) adj.push(n + NXn);
        if (adj.length) walls.push([n, adj]);
      }
    }
    for (var it = 0; it < 1400; it++) {
      for (q = 0; q < walls.length; q++) {
        var wn = walls[q][0], a = walls[q][1], sum = 0;
        for (var t = 0; t < a.length; t++) sum += psi[a[t]] - psi[wn];
        om[wn] = 0.5 * om[wn] + 0.5 * (-2 * sum / a.length);
      }
      for (q = 0; q < inner.length; q++) {
        n = inner[q];
        om[n] += 1.5 * ((om[n - 1] + om[n + 1] + om[n - NXn] + om[n + NXn]) / 4 - om[n]);
      }
      for (q = 0; q < inner.length; q++) {
        n = inner[q];
        psi[n] += 1.7 * ((psi[n - 1] + psi[n + 1] + psi[n - NXn] + psi[n + NXn] + om[n]) / 4 - psi[n]);
      }
    }
    // face velocities from corner stream function: exactly divergence-free
    for (j = 0; j < NY; j++) for (i = 0; i <= NX; i++)
      ux[j * (NX + 1) + i] = psi[(j + 1) * NXn + i] - psi[j * NXn + i];
    for (j = 1; j < NY; j++) for (i = 0; i < NX; i++)
      uy[idx(i, j)] = -(psi[j * NXn + i + 1] - psi[j * NXn + i]);
    for (j = 0; j < NY; j++) for (i = 0; i < NX; i++) if (solid[idx(i, j)]) {
      ux[j * (NX + 1) + i] = 0; ux[j * (NX + 1) + i + 1] = 0; uy[idx(i, j)] = 0; if (j < NY - 1) uy[idx(i, j + 1)] = 0;
    }
  }

  function scaleVelocities(setScale) {
    var i, sum = 0, n = 0, mx = 0;
    for (i = 0; i < ux.length; i++) { var a = Math.abs(ux[i]); if (a > 0) { sum += a; n++; } if (a > mx) mx = a; }
    if (setScale) {
      var target = NX / (CROSS[scene] * DURATION[scene] * 60 * SUB);
      scale = Math.min(target / Math.max(sum / Math.max(1, n), 1e-9), 0.4 / Math.max(mx, 1e-9));
    }
    for (i = 0; i < ux.length; i++) ux[i] = Math.max(-0.4, Math.min(0.4, ux[i] * scale));
    for (i = 0; i < uy.length; i++) uy[i] = Math.max(-0.4, Math.min(0.4, uy[i] * scale));
  }

  // ---------- transport ----------
  function face(cu, cd, cuu) {                   // TVD face value, van Leer limiter
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
      k = row;                                    // inlet (first order)
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
      k = row + NX - 1;                           // outlet
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
          var r = 0.4 * A[k] * B[k];
          A[k] -= r; B[k] -= r;
          glow[k] = glow[k] * 0.99 + r;
        }
      }
    }
    if (scene === 1) moveTracers();
    if (scene === 2) dissolve();
  }

  function dissolve() {
    var changed = false, nb = [0, 0, 0, 0];
    for (var j = 0; j < NY; j++) for (var i = 0; i < NX; i++) {
      var k = idx(i, j);
      glow[k] *= 0.9;
      if (!solid[k]) {                            // thin rims of rock in partly open cells
        if (mass[k] > 0 && A[k] > 0.01) { mass[k] = Math.max(0, mass[k] - KDISS * 2 * A[k]); glow[k] += KDISS * 40 * A[k]; }
        continue;
      }
      var n = 0, acid = 0;
      if (i > 0 && !solid[k - 1]) nb[n++] = k - 1;
      if (i < NX - 1 && !solid[k + 1]) nb[n++] = k + 1;
      if (j > 0 && !solid[k - NX]) nb[n++] = k - NX;
      if (j < NY - 1 && !solid[k + NX]) nb[n++] = k + NX;
      for (var q = 0; q < n; q++) acid += A[nb[q]];
      if (acid < 0.01) continue;
      var d = KDISS * acid;
      mass[k] -= d; glow[k] += d * 40;
      for (q = 0; q < n; q++) A[nb[q]] *= 0.996;  // a little acid is used up
      if (mass[k] <= 0.5) {                       // less than half rock left: now pore space
        solid[k] = 0; changed = true;
        var pa = 0; for (q = 0; q < n; q++) pa += p[nb[q]];
        p[k] = pa / n; A[k] = 0;
      }
    }
    if (changed) { sor(25); pressureVelocities(); scaleVelocities(false); }
  }

  // ---------- tracer particles (streak look of the microfluidic images) ----------
  function velAt(x, y) {
    var i = Math.floor(x), j = Math.floor(y);
    if (i < 0 || i >= NX || j < 0 || j >= NY) return [0, 0];
    var fx = x - i, fy = y - j;
    var u = ux[j * (NX + 1) + i] * (1 - fx) + ux[j * (NX + 1) + i + 1] * fx;
    var v = (j > 0 ? uy[idx(i, j)] : 0) * (1 - fy) + (j < NY - 1 ? uy[idx(i, j + 1)] : 0) * fy;
    return [u, v];
  }
  function seedTracer(t, atInlet) {
    for (var tries = 0; tries < 40; tries++) {
      var x = atInlet ? Math.random() * 1.5 : Math.random() * NX, y = Math.random() * NY;
      if (!solid[idx(Math.min(NX - 1, x | 0), Math.min(NY - 1, y | 0))]) { t.x = x; t.y = y; return; }
    }
  }
  function moveTracers() {
    for (var q = 0; q < tracers.length; q++) {
      var t = tracers[q], v1 = velAt(t.x, t.y);
      var v2 = velAt(t.x + v1[0] * SUB * 0.5, t.y + v1[1] * SUB * 0.5);
      t.vx = v2[0] * SUB; t.vy = v2[1] * SUB;
      t.x += t.vx; t.y += t.vy;
      if (t.x >= NX - 0.5 || t.x < 0 || t.y < 0 || t.y >= NY || solid[idx(t.x | 0, t.y | 0)]) seedTracer(t, t.x >= NX - 0.5);
    }
  }

  // ---------- drawing ----------
  function lut(stops) {
    var t = new Uint8ClampedArray(256 * 3);
    for (var q = 0; q < 256; q++) {
      var x = q / 255 * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
      for (var c = 0; c < 3; c++) t[q * 3 + c] = stops[i][c] + (stops[i + 1][c] - stops[i][c]) * f;
    }
    return t;
  }
  var DARK = [11, 19, 30];
  var HOT = lut([[6, 8, 14], [120, 10, 8], [220, 60, 15], [255, 170, 30], [255, 240, 140], [255, 255, 250]]);
  var GLOW = lut([[0, 0, 0], [150, 20, 10], [235, 90, 20], [255, 200, 60], [255, 250, 220]]);
  var SOLID = [[78, 86, 98], [3, 8, 10], [196, 142, 98]];

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
        var sf = 0, fw = 0, a = 0, b = 0, g = 0;
        for (var q = 0; q < 4; q++) {
          var kk = ks[q], w = ws[q];
          if (scene === 2) sf += w * mass[kk]; else if (solid[kk]) sf += w;
          if (!solid[kk]) { fw += w; a += w * A[kk]; b += w * B[kk]; }
          g += w * glow[kk];
        }
        if (fw > 0) { a /= fw; b /= fw; }
        var r, gr, bl, o = (y * OW + x) * 4;
        if (scene === 0) {
          var mi = Math.round(a * 255) * 3; r = HOT[mi]; gr = HOT[mi + 1]; bl = HOT[mi + 2];
        } else if (scene === 1) {                 // microscopy look: red invading, cyan resident
          r = 4 + 150 * a * 0.45 + 10 * b * 0.4; gr = 16 + 30 * a * 0.45 + 150 * b * 0.4; bl = 20 + 30 * a * 0.45 + 160 * b * 0.4;
          var h = Math.sqrt(g / gmax);
          if (h > 0.05) { var hi = Math.round(Math.min(1, h) * 255) * 3; r = Math.max(r, GLOW[hi]); gr = Math.max(gr, GLOW[hi + 1]); bl = Math.max(bl, GLOW[hi + 2]); }
        } else {
          r = DARK[0] + (80 - DARK[0]) * a * 0.75; gr = DARK[1] + (150 - DARK[1]) * a * 0.75; bl = DARK[2] + (255 - DARK[2]) * a * 0.75;
        }
        var alpha = Math.max(0, Math.min(1, (sf - 0.4) / 0.2));
        if (alpha > 0) { var sc = SOLID[scene]; r += (sc[0] - r) * alpha; gr += (sc[1] - gr) * alpha; bl += (sc[2] - bl) * alpha; }
        if (scene === 2 && g > 0.02) { var gg = Math.min(1, g); r += (255 - r) * gg; gr += (170 - gr) * gg; bl += (60 - bl) * gg; }
        d[o] = r; d[o + 1] = gr; d[o + 2] = bl; d[o + 3] = 255;
      }
    }
    offCtx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(off, 0, 0, W, H);
    var sx = W / NX, sy = H / NY;
    if (scene === 0) {                            // crisp round grains on top
      ctx.fillStyle = "rgb(" + SOLID[0].join(",") + ")";
      ctx.beginPath();
      circles.forEach(function (c) {
        var rr = c.r + 0.35;
        ctx.moveTo(c.x * sx + rr * sx, c.y * sy);
        ctx.ellipse(c.x * sx, c.y * sy, rr * sx, rr * sy, 0, 0, Math.PI * 2);
      });
      ctx.fill();
    }
    if (scene === 1) {                            // flow streaks
      ctx.lineCap = "round"; ctx.lineWidth = 1.4;
      ctx.globalCompositeOperation = "lighter";
      for (var q2 = 0; q2 < tracers.length; q2++) {
        var t = tracers[q2], ti = Math.min(NX - 1, t.x | 0), tj = Math.min(NY - 1, t.y | 0), kt = idx(ti, tj);
        var inv = A[kt] > B[kt];
        ctx.strokeStyle = inv ? "rgba(255,90,80,.75)" : "rgba(70,235,240,.75)";
        // streak length grows slowly with speed, so the weak eddies in the pores still show as curls
        var sp = Math.sqrt(t.vx * t.vx + t.vy * t.vy) + 1e-9, L = (1.2 + 3 * Math.pow(sp / 0.5, 0.4)) / sp;
        ctx.beginPath();
        ctx.moveTo((t.x - t.vx * L) * sx, (t.y - t.vy * L) * sy);
        ctx.lineTo(t.x * sx, t.y * sy);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = "source-over";
    }
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
    circles = []; tracers = [];
    off.width = NX * UP; off.height = NY * UP; img = offCtx.createImageData(NX * UP, NY * UP);

    if (s === 1) {
      deadEndPores();
      stokes();
      for (var k = 0; k < N; k++) B[k] = solid[k] ? 0 : 1;
      var nt = Math.round(NX * 3.2);
      for (var q = 0; q < nt; q++) { var t = { x: 0, y: 0, vx: 0, vy: 0 }; seedTracer(t, false); tracers.push(t); }
    } else {
      if (s === 0) grainPack(); else pillars();
      for (var i = 0; i < NX; i++) for (var j = 0; j < NY; j++) p[idx(i, j)] = 1 - (i + 0.5) / NX;
      sor(1000);
      pressureVelocities();
    }
    scaleVelocities(true);

    tabs.forEach(function (tb, q2) {
      tb.classList.toggle("active", q2 === s);
      tb.setAttribute("aria-selected", q2 === s ? "true" : "false");
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
