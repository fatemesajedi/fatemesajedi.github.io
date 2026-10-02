// Interactive coffee cup: milk is poured in, visitors stir it with a spoon,
// and a meter shows how well mixed the cup is.
// Flow: a small incompressible fluid solver (viscosity + pressure projection).
// Milk: its outline is carried by the flow (points added where it stretches), so
// stirring makes sharp lamellae. Diffusion is a blur that grows with time: it is
// paused while stirring until the cup is ~30% mixed, and creeps on by itself
// whenever the cup is left alone. After very long stirring the milk is handed
// over to a grid (advection + diffusion).
(function () {
  var canvas = document.getElementById("coffee-canvas");
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext("2d");
  var meterFill = document.getElementById("mix-meter-fill");
  var meterText = document.getElementById("mix-meter-value");
  var hint = document.getElementById("coffee-hint");
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var G = 64;                     // flow grid (G x G over the cup)
  var L = 320;                    // milk image resolution
  var F = 128;                    // milk grid once the outline gets too long
  var MAXSEG = 0.35, MAXPTS = 40000;
  var D_IDLE = 0.0006, D_MIX = 0.004, SHARP_UNTIL = 0.3;   // diffusion (grid units^2 per frame)
  var S, R, CX, CY, dpr;
  var vx = new Float32Array(G * G), vy = new Float32Array(G * G);
  var tmpx = new Float32Array(G * G), tmpy = new Float32Array(G * G);
  var pres = new Float32Array(G * G), divg = new Float32Array(G * G);
  var inside = new Uint8Array(G * G);
  var curves = [], pours = [], gridMode = false, M = new Float32Array(F * F), M2 = new Float32Array(F * F);
  var sigma2 = 0, mix = 0, cv0 = 0, stirTimer = 0;
  var spoon = null, lastSpoon = null, interacted = false, visible = true, poured = false;

  var milk = document.createElement("canvas"); milk.width = milk.height = L;      // milk amount (alpha)
  var mctx = milk.getContext("2d");
  var colour = document.createElement("canvas"); colour.width = colour.height = L; // coloured coffee surface
  var cctx = colour.getContext("2d"), cimg = cctx.createImageData(L, L);
  var fcan = document.createElement("canvas"); fcan.width = fcan.height = F;
  var fctx = fcan.getContext("2d"), fimg = fctx.createImageData(F, F);

  // coffee -> latte -> cream, by milk amount
  var LUT = new Uint8ClampedArray(256 * 3);
  (function () {
    var C0 = [52, 30, 17], C1 = [188, 138, 88], C2 = [250, 243, 232];
    for (var q = 0; q < 256; q++) {
      var t = q / 255, c;
      if (t < 0.32) { var a = t / 0.32; c = [C0[0] + (C1[0] - C0[0]) * a, C0[1] + (C1[1] - C0[1]) * a, C0[2] + (C1[2] - C0[2]) * a]; }
      else { var b = (t - 0.32) / 0.68; c = [C1[0] + (C2[0] - C1[0]) * b, C1[1] + (C2[1] - C1[1]) * b, C1[2] + (C2[2] - C1[2]) * b]; }
      LUT[q * 3] = c[0]; LUT[q * 3 + 1] = c[1]; LUT[q * 3 + 2] = c[2];
    }
  })();

  function resize() {
    dpr = window.devicePixelRatio || 1;
    S = canvas.clientWidth;
    canvas.width = canvas.height = S * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    CX = S * 0.47; CY = S * 0.5; R = S * 0.36;
  }

  function setupGrid() {
    for (var j = 0; j < G; j++) for (var i = 0; i < G; i++) {
      var x = (i + 0.5) / G * 2 - 1, y = (j + 0.5) / G * 2 - 1;
      inside[j * G + i] = x * x + y * y < 0.97 ? 1 : 0;
    }
  }

  function newCup() {
    curves = []; pours = []; gridMode = false; M.fill(0);
    sigma2 = 0; mix = 0; cv0 = 0;
    vx.fill(0); vy.fill(0); pres.fill(0);
    pour();
  }

  function pour() {
    var a = Math.random() * Math.PI * 2, r = Math.random() * 0.3;
    var p = { cx: G / 2 + Math.cos(a) * r * G / 2, cy: G / 2 + Math.sin(a) * r * G / 2, t: 0, T: 50, rmax: G * 0.15, n: 360 };
    p.curve = { x: new Float64Array(p.n), y: new Float64Array(p.n) };
    if (!gridMode) curves.push(p.curve);
    pours.push(p);
    poured = true;
  }

  function sample(f, x, y) {
    var i = Math.max(0, Math.min(G - 1.001, x - 0.5)), j = Math.max(0, Math.min(G - 1.001, y - 0.5));
    var i0 = i | 0, j0 = j | 0, fx = i - i0, fy = j - j0, k = j0 * G + i0;
    return f[k] * (1 - fx) * (1 - fy) + f[k + 1] * fx * (1 - fy) + f[k + G] * (1 - fx) * fy + f[k + G + 1] * fx * fy;
  }

  function blur(f, tmp, w) {
    for (var j = 1; j < G - 1; j++) for (var i = 1; i < G - 1; i++) {
      var k = j * G + i;
      tmp[k] = f[k] * (1 - w) + (f[k - 1] + f[k + 1] + f[k - G] + f[k + G]) * w / 4;
    }
    f.set(tmp);
  }

  // Coffee is incompressible: remove the divergent part of the flow
  // (pressure projection, Jacobi iterations, solid cup wall).
  function project() {
    var k, i, j;
    for (j = 1; j < G - 1; j++) for (i = 1; i < G - 1; i++) {
      k = j * G + i;
      divg[k] = inside[k] ? -0.5 * (vx[k + 1] - vx[k - 1] + vy[k + G] - vy[k - G]) : 0;
    }
    for (var it = 0; it < 24; it++) {
      for (j = 1; j < G - 1; j++) for (i = 1; i < G - 1; i++) {
        k = j * G + i;
        if (!inside[k]) continue;
        var pc = pres[k], s = 0;
        s += inside[k - 1] ? pres[k - 1] : pc;
        s += inside[k + 1] ? pres[k + 1] : pc;
        s += inside[k - G] ? pres[k - G] : pc;
        s += inside[k + G] ? pres[k + G] : pc;
        pres[k] = (divg[k] + s) / 4;
      }
    }
    for (j = 1; j < G - 1; j++) for (i = 1; i < G - 1; i++) {
      k = j * G + i;
      if (!inside[k]) continue;
      var pk = pres[k];
      vx[k] -= 0.5 * ((inside[k + 1] ? pres[k + 1] : pk) - (inside[k - 1] ? pres[k - 1] : pk));
      vy[k] -= 0.5 * ((inside[k + G] ? pres[k + G] : pk) - (inside[k - G] ? pres[k - G] : pk));
    }
  }

  // ----- milk outline -----
  var LIM = G / 2 * 0.97;
  function keepInside(xs, ys, q) {
    var ox = xs[q] - G / 2, oy = ys[q] - G / 2, od = Math.sqrt(ox * ox + oy * oy);
    if (od > LIM) { xs[q] = G / 2 + ox / od * LIM; ys[q] = G / 2 + oy / od * LIM; }
  }
  function advectCurve(c) {
    var xs = c.x, ys = c.y;
    for (var q = 0; q < xs.length; q++) {
      var x = xs[q], y = ys[q], ux = sample(vx, x, y), uy = sample(vy, x, y);
      var mx = x + ux * 0.5, my = y + uy * 0.5;
      xs[q] = x + sample(vx, mx, my); ys[q] = y + sample(vy, mx, my);
      keepInside(xs, ys, q);
    }
  }
  function refine(c) {
    var xs = c.x, ys = c.y, n = xs.length, need = 0, q;
    for (q = 0; q < n; q++) { var p = (q + 1) % n, dx = xs[p] - xs[q], dy = ys[p] - ys[q]; if (dx * dx + dy * dy > MAXSEG * MAXSEG) need++; }
    if (!need) return;
    var nx = new Float64Array(n + need), ny = new Float64Array(n + need), o = 0;
    for (q = 0; q < n; q++) {
      var p2 = (q + 1) % n, ex = xs[p2] - xs[q], ey = ys[p2] - ys[q];
      nx[o] = xs[q]; ny[o++] = ys[q];
      if (ex * ex + ey * ey > MAXSEG * MAXSEG) {      // new point on a smooth curve through the neighbours
        var pm = (q - 1 + n) % n, pp = (q + 2) % n;
        nx[o] = (9 * (xs[q] + xs[p2]) - xs[pm] - xs[pp]) / 16; ny[o++] = (9 * (ys[q] + ys[p2]) - ys[pm] - ys[pp]) / 16;
      }
    }
    c.x = nx; c.y = ny;
  }
  function fillCurves(g, scale, blurPx) {
    g.filter = blurPx > 0.3 ? "blur(" + blurPx.toFixed(2) + "px)" : "none";
    g.fillStyle = "#fff";
    for (var c = 0; c < curves.length; c++) {
      var xs = curves[c].x, ys = curves[c].y;
      g.beginPath(); g.moveTo(xs[0] * scale, ys[0] * scale);
      for (var q = 1; q < xs.length; q++) g.lineTo(xs[q] * scale, ys[q] * scale);
      g.closePath(); g.fill();
    }
    g.filter = "none";
  }

  // ----- milk on a grid (after very long stirring) -----
  function toGridMode() {
    fctx.clearRect(0, 0, F, F);
    fillCurves(fctx, F / G, Math.sqrt(sigma2) * F / G);
    var d = fctx.getImageData(0, 0, F, F).data;
    for (var k = 0; k < F * F; k++) M[k] = d[k * 4 + 3] / 255;
    curves = []; gridMode = true;
  }
  function gridStep(D) {
    var h = G / F, i, j, k;
    for (j = 0; j < F; j++) for (i = 0; i < F; i++) {      // advection (semi-Lagrangian)
      var x = (i + 0.5) * h, y = (j + 0.5) * h, ux = sample(vx, x, y), uy = sample(vy, x, y);
      var sx = ((x - ux) / h) - 0.5, sy = ((y - uy) / h) - 0.5;
      sx = Math.max(0, Math.min(F - 1.001, sx)); sy = Math.max(0, Math.min(F - 1.001, sy));
      var i0 = sx | 0, j0 = sy | 0, fx = sx - i0, fy = sy - j0, kk = j0 * F + i0;
      M2[j * F + i] = M[kk] * (1 - fx) * (1 - fy) + M[kk + 1] * fx * (1 - fy) + M[kk + F] * (1 - fx) * fy + M[kk + F + 1] * fx * fy;
    }
    var Df = Math.min(0.24, D / (h * h));                   // diffusion
    for (j = 0; j < F; j++) for (i = 0; i < F; i++) {
      k = j * F + i;
      var l = i > 0 ? k - 1 : k, r = i < F - 1 ? k + 1 : k, u = j > 0 ? k - F : k, dn = j < F - 1 ? k + F : k;
      M[k] = M2[k] + Df * (M2[l] + M2[r] + M2[u] + M2[dn] - 4 * M2[k]);
    }
  }
  function stampDisc(cx, cy, r) {
    var h = G / F;
    for (var j = Math.max(0, ((cy - r) / h) | 0); j < Math.min(F, (cy + r) / h + 1); j++)
      for (var i = Math.max(0, ((cx - r) / h) | 0); i < Math.min(F, (cx + r) / h + 1); i++) {
        var dx = (i + 0.5) * h - cx, dy = (j + 0.5) * h - cy;
        if (dx * dx + dy * dy < r * r) M[j * F + i] = 1;
      }
  }

  function step() {
    // pouring: the milk spot grows, with a little outward splash
    for (var q = pours.length - 1; q >= 0; q--) {
      var p = pours[q]; p.t++;
      var r = p.rmax * Math.sqrt(Math.min(1, p.t / p.T));
      if (gridMode) stampDisc(p.cx, p.cy, r);
      else for (var n = 0; n < p.n; n++) {
        var a = n / p.n * 2 * Math.PI;
        p.curve.x[n] = p.cx + r * Math.cos(a); p.curve.y[n] = p.cy + r * Math.sin(a);
        keepInside(p.curve.x, p.curve.y, n);
      }
      var pi = Math.round(p.cx), pj = Math.round(p.cy);
      for (var dj = -5; dj <= 5; dj++) for (var di = -5; di <= 5; di++) {
        var d = Math.sqrt(di * di + dj * dj);
        if (d === 0 || d > 5) continue;
        var kk = (pj + dj) * G + (pi + di);
        if (kk >= 0 && kk < G * G) { vx[kk] += di / d * 0.006; vy[kk] += dj / d * 0.006; }
      }
      if (p.t >= p.T) pours.splice(q, 1);
    }

    // spoon pushes the coffee
    var stirring = false;
    if (spoon && lastSpoon) {
      var dx = spoon.x - lastSpoon.x, dy = spoon.y - lastSpoon.y, sl = Math.sqrt(dx * dx + dy * dy);
      if (sl > 0.02) stirTimer = 12;              // counts as stirring for a moment after each move
      if (sl > 1.2) { dx *= 1.2 / sl; dy *= 1.2 / sl; }   // very fast flicks shouldn't explode the cup
      var gx = spoon.x, gy = spoon.y, rad = 4.5;
      for (var j = Math.max(0, (gy - rad) | 0); j < Math.min(G, gy + rad + 1); j++)
        for (var i = Math.max(0, (gx - rad) | 0); i < Math.min(G, gx + rad + 1); i++) {
          var ex = i + 0.5 - gx, ey = j + 0.5 - gy, w = 1 - Math.sqrt(ex * ex + ey * ey) / rad;
          if (w > 0) { var k = j * G + i; vx[k] += (dx - vx[k]) * w * 0.6; vy[k] += (dy - vy[k]) * w * 0.6; }
        }
    }
    lastSpoon = spoon;
    if (stirTimer > 0) { stirTimer--; stirring = true; }

    // viscosity: smooth + slow down the flow; keep it inside the cup
    blur(vx, tmpx, 0.35); blur(vy, tmpy, 0.35);
    for (var k2 = 0; k2 < G * G; k2++) {
      if (!inside[k2]) { vx[k2] = vy[k2] = 0; continue; }
      vx[k2] *= 0.988; vy[k2] *= 0.988;
      var sp = vx[k2] * vx[k2] + vy[k2] * vy[k2];
      if (sp > 0.64) { var f = 0.8 / Math.sqrt(sp); vx[k2] *= f; vy[k2] *= f; }
    }
    project();

    // diffusion: paused while stirring an unmixed cup, creeps on when left alone
    var D = stirring ? (mix < SHARP_UNTIL ? 0 : D_MIX) : D_IDLE;

    if (gridMode) { gridStep(D); return; }
    sigma2 += 2 * D;
    var pts = 0;
    for (var c = 0; c < curves.length; c++) {
      var growing = false;
      for (q = 0; q < pours.length; q++) if (pours[q].curve === curves[c]) growing = true;
      if (growing) continue;
      advectCurve(curves[c]); refine(curves[c]);
      pts += curves[c].x.length;
    }
    if (pts > MAXPTS) toGridMode();
  }

  // ----- drawing -----
  function milkLayer() {
    mctx.setTransform(1, 0, 0, 1, 0, 0);
    mctx.clearRect(0, 0, L, L);
    if (gridMode) {
      var fd = fimg.data;
      for (var k = 0; k < F * F; k++) { fd[k * 4] = fd[k * 4 + 1] = fd[k * 4 + 2] = 255; fd[k * 4 + 3] = Math.min(255, M[k] * 255); }
      fctx.putImageData(fimg, 0, 0);
      mctx.imageSmoothingEnabled = true;
      mctx.drawImage(fcan, 0, 0, L, L);
    } else {
      fillCurves(mctx, L / G, Math.sqrt(sigma2) * L / G);
    }
    return mctx.getImageData(0, 0, L, L).data;
  }

  function render() {
    var md = milkLayer(), cd = cimg.data;
    for (var k = 0; k < L * L; k++) {
      var q = md[k * 4 + 3] * 3;
      cd[k * 4] = LUT[q]; cd[k * 4 + 1] = LUT[q + 1]; cd[k * 4 + 2] = LUT[q + 2]; cd[k * 4 + 3] = 255;
    }
    cctx.putImageData(cimg, 0, 0);
    measure(md);

    var cs = getComputedStyle(document.documentElement);
    ctx.clearRect(0, 0, S, S);
    // saucer
    ctx.fillStyle = cs.getPropertyValue("--saucer").trim() || "#ece7df";
    ctx.beginPath(); ctx.arc(CX, CY, R * 1.32, 0, Math.PI * 2); ctx.fill();
    // cup handle
    ctx.strokeStyle = cs.getPropertyValue("--cup").trim() || "#fff";
    ctx.lineWidth = R * 0.16; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(CX + R * 1.05, CY - R * 0.18); ctx.lineTo(CX + R * 1.32, CY - R * 0.12);
    ctx.lineTo(CX + R * 1.32, CY + R * 0.12); ctx.lineTo(CX + R * 1.05, CY + R * 0.18); ctx.stroke();
    // cup rim
    ctx.fillStyle = cs.getPropertyValue("--cup").trim() || "#fff";
    ctx.shadowColor = "rgba(0,0,0,.18)"; ctx.shadowBlur = R * 0.12;
    ctx.beginPath(); ctx.arc(CX, CY, R * 1.1, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    // coffee surface
    ctx.save();
    ctx.beginPath(); ctx.arc(CX, CY, R, 0, Math.PI * 2); ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(colour, CX - R, CY - R, R * 2, R * 2);
    var shine = ctx.createRadialGradient(CX - R * 0.4, CY - R * 0.45, 0, CX - R * 0.4, CY - R * 0.45, R * 0.9);
    shine.addColorStop(0, "rgba(255,255,255,.14)"); shine.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = shine; ctx.fillRect(CX - R, CY - R, R * 2, R * 2);
    var edge = ctx.createRadialGradient(CX, CY, R * 0.75, CX, CY, R);
    edge.addColorStop(0, "rgba(0,0,0,0)"); edge.addColorStop(1, "rgba(0,0,0,.28)");
    ctx.fillStyle = edge; ctx.fillRect(CX - R, CY - R, R * 2, R * 2);
    ctx.restore();
    // milk stream while pouring
    pours.forEach(function (p) {
      var sx = CX + (p.cx / G * 2 - 1) * R, sy = CY + (p.cy / G * 2 - 1) * R;
      ctx.strokeStyle = "rgba(250,245,236,.95)"; ctx.lineWidth = 5; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(sx - R * 0.5, -10); ctx.quadraticCurveTo(sx - R * 0.1, sy - R * 0.6, sx, sy); ctx.stroke();
    });
    drawSpoon();
  }

  function drawSpoon() {
    var x, y;
    if (spoon) { x = CX + (spoon.x / G * 2 - 1) * R; y = CY + (spoon.y / G * 2 - 1) * R; }
    else { x = CX + R * 0.55; y = CY + R * 0.55; }   // resting in the cup
    var ang = Math.atan2(S - y, S - x);              // handle points to bottom-right corner
    ctx.save();
    ctx.translate(x, y); ctx.rotate(ang);
    ctx.fillStyle = "#c9ced3"; ctx.strokeStyle = "#9aa1a8"; ctx.lineWidth = 1;
    ctx.shadowColor = "rgba(0,0,0,.25)"; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2;
    ctx.beginPath(); ctx.ellipse(0, 0, R * 0.16, R * 0.105, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(R * 0.12, -R * 0.03, R * 1.1, R * 0.06, R * 0.03) : ctx.rect(R * 0.12, -R * 0.03, R * 1.1, R * 0.06);
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  // How mixed? Unevenness of the milk seen in 20 x 20 blocks (like looking at the
  // cup from a little distance), on a log scale.
  var frame = 0;
  function measure(md) {
    if (frame % 8 !== 0) return;
    var B = 20, bs = L / B, vals = [], sum = 0, sum2 = 0;
    for (var bj = 0; bj < B; bj++) for (var bi = 0; bi < B; bi++) {
      var x = (bi + 0.5) / B * 2 - 1, y = (bj + 0.5) / B * 2 - 1;
      if (x * x + y * y > 0.8) continue;
      var s = 0, n = 0;
      for (var j = bj * bs; j < (bj + 1) * bs; j += 2) for (var i = bi * bs; i < (bi + 1) * bs; i += 2) { s += md[((j | 0) * L + (i | 0)) * 4 + 3]; n++; }
      vals.push(s / n);
    }
    for (var v = 0; v < vals.length; v++) { sum += vals[v]; sum2 += vals[v] * vals[v]; }
    var mean = sum / vals.length;
    if (mean < 1) { mix = 0; meterFill.style.width = "0%"; meterText.textContent = "0%"; return; }
    var cv = Math.sqrt(Math.max(0, sum2 / vals.length - mean * mean)) / mean;
    if (!pours.length && cv > cv0) cv0 = cv;
    var target = 0.2;                 // unevenness at which the cup looks fully mixed = 100%
    var m = cv0 <= target ? 1 : Math.max(0, Math.min(1, Math.log(cv0 / Math.max(cv, target)) / Math.log(cv0 / target)));
    mix = m;
    var pct = Math.round(m * 100);
    meterFill.style.width = pct + "%";
    meterText.textContent = pct >= 100 ? "100% ✨" : pct + "%";
  }

  function toGrid(e) {
    var rect = canvas.getBoundingClientRect();
    var x = (e.clientX - rect.left - CX) / R, y = (e.clientY - rect.top - CY) / R;
    var d = Math.sqrt(x * x + y * y);
    if (d > 0.93) { x = x / d * 0.93; y = y / d * 0.93; }
    return { x: (x + 1) / 2 * G, y: (y + 1) / 2 * G, out: d > 1.35 };
  }

  canvas.addEventListener("pointermove", function (e) {
    var g = toGrid(e);
    if (g.out) { spoon = null; return; }
    if (e.pointerType !== "mouse" && !e.buttons) return;
    spoon = g; visible = true;
    if (!interacted) { interacted = true; if (hint) hint.classList.add("gone"); }
  });
  canvas.addEventListener("pointerdown", function (e) { spoon = toGrid(e); lastSpoon = spoon; });
  canvas.addEventListener("pointerleave", function () { spoon = null; });
  canvas.addEventListener("pointerup", function (e) { if (e.pointerType !== "mouse") spoon = null; });

  document.getElementById("coffee-pour").addEventListener("click", function () { pour(); });
  document.getElementById("coffee-reset").addEventListener("click", function () { newCup(); });

  function loop() {
    if (visible) { step(); frame++; render(); }
    requestAnimationFrame(loop);
  }

  resize(); setupGrid();
  window.addEventListener("resize", function () { resize(); render(); });

  // Stirring is started by the visitor, so it always runs. With "reduce motion"
  // switched on, the milk is already in the cup instead of being poured.
  if (reduceMotion) { pour(); while (pours.length) step(); render(); }
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      var e = entries[0];
      visible = e.isIntersecting;
      if (!poured && e.intersectionRatio >= 0.4) setTimeout(pour, 400);   // pour when the cup scrolls into view
    }, { threshold: [0, 0.4] }).observe(canvas);
  } else {
    pour();
  }
  loop();
})();
