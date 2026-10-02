// "Let's learn mixing together": two droplets, stirred then diffused.
// Stage "stir": pure advection. Each droplet boundary is a closed chain of points
// moved with the flow (RK2); new points are inserted wherever the boundary stretches.
// So edges stay sharp, droplet areas are conserved, and the stretching is measured
// exactly as the boundary length.
// Stage "diffuse": the droplets are rasterised onto a grid, then advection + diffusion.
// The stirring flow is incompressible (built from a stream function) and vanishes at the walls.
(function () {
  var root = document.getElementById("learn-mixing");
  if (!root) return;
  var canvas = root.querySelector("canvas"), ctx = canvas.getContext("2d");
  var steps = [].slice.call(root.querySelectorAll(".lm-step"));
  var dots = [].slice.call(root.querySelectorAll(".lm-progress li"));
  var stretchOut = root.querySelector("[data-out=stretch]"), unmixedOut = root.querySelector("[data-out=unmixed]");
  var unmixedBar = root.querySelector(".lm-bar i");
  var btnNext2 = root.querySelector("[data-go='3']"), btnNext3 = root.querySelector("[data-go='4']");
  var btnAuto = [].slice.call(root.querySelectorAll("[data-auto]"));
  var capNote = root.querySelector(".lm-capped");

  var G = 220;                       // grid for the diffusion stage
  var MAXSEG = 0.0035;
  var R = new Float32Array(G * G), C = new Float32Array(G * G), R2 = new Float32Array(G * G), C2 = new Float32Array(G * G);
  var red, cyan, len0 = 1, var0 = 1;
  var STRETCH_MAX = 100, capped = false;
  var stage = 1, diffusing = false, auto = false, autoT = 0, pointer = null, lastPointer = null;
  var frame = 0, PX, visible = true;
  var off = document.createElement("canvas"), offCtx = off.getContext("2d"), offImg;
  var COL = { bg: "#101218", red: "rgb(235,55,40)", cyan: "rgb(40,220,230)" };

  // ----- the two droplets -----
  function blob(cx, cy, rf, n) {
    var xs = new Float64Array(n), ys = new Float64Array(n);
    for (var q = 0; q < n; q++) { var a = q / n * 2 * Math.PI, r = rf(a); xs[q] = cx + r * Math.cos(a); ys[q] = cy + r * Math.sin(a); }
    return { x: xs, y: ys };
  }
  function makeDroplets() {
    red = blob(0.62, 0.36, function () { return 0.2; }, 500);
    cyan = blob(0.36, 0.62, function (a) { return 0.165 + 0.018 * Math.sin(2 * a + 0.6) + 0.01 * Math.sin(3 * a); }, 450);
  }

  // ----- stirring flow (stream function, zero at the walls) -----
  function wall(t) { var s = 2 * t - 1; return [1 - Math.pow(s, 8), -16 * Math.pow(s, 7)]; }   // value, derivative
  var vel = [0, 0];
  function velocity(x, y) {
    var u = 0, v = 0;
    if (pointer && lastPointer) {                 // a "spoon" dragged by the visitor
      var dx = pointer.x - lastPointer.x, dy = pointer.y - lastPointer.y;
      var l = Math.sqrt(dx * dx + dy * dy); if (l > 0.03) { dx *= 0.03 / l; dy *= 0.03 / l; }
      var rx = x - pointer.x, ry = y - pointer.y, s2 = 0.09 * 0.09, g = Math.exp(-(rx * rx + ry * ry) / (2 * s2));
      if (g > 1e-4) {
        var wx = wall(x), wy = wall(y), W = wx[0] * wy[0], Wx = wx[1] * wy[0], Wy = wx[0] * wy[1];
        var Sv = dx * ry - dy * rx, psi = Sv * g;
        var psiX = -dy * g + Sv * (-rx / s2) * g, psiY = dx * g + Sv * (-ry / s2) * g;
        u += psiY * W + psi * Wy; v -= psiX * W + psi * Wx;
      }
    }
    if (auto) {                                   // alternating cellular flows = chaotic stirring
      var A = 0.0042, ph = Math.floor(autoT / 70) % 3, P = Math.PI;
      if (ph === 0) { u += A * P * Math.sin(P * x) * Math.cos(P * y); v -= A * P * Math.cos(P * x) * Math.sin(P * y); }
      else if (ph === 1) { u += A * P * Math.sin(2 * P * x) * Math.cos(P * y); v -= 2 * A * P * Math.cos(2 * P * x) * Math.sin(P * y); }
      else { u += 2 * A * P * Math.sin(P * x) * Math.cos(2 * P * y); v -= A * P * Math.cos(P * x) * Math.sin(2 * P * y); }
    }
    vel[0] = u; vel[1] = v; return vel;
  }
  function stirring() { if (capped && !diffusing) return false; return auto || (pointer && lastPointer && (pointer.x !== lastPointer.x || pointer.y !== lastPointer.y)); }

  // ----- stage 2: move the boundaries, refine where they stretch -----
  function advectCurve(c) {
    var xs = c.x, ys = c.y, n = xs.length;
    for (var q = 0; q < n; q++) {
      var x = xs[q], y = ys[q], v = velocity(x, y), u1 = v[0], v1 = v[1];
      v = velocity(x + 0.5 * u1, y + 0.5 * v1);
      xs[q] = x + v[0]; ys[q] = y + v[1];
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
      if (ex * ex + ey * ey > MAXSEG * MAXSEG) {   // new point on a smooth curve through the neighbours
        var pm = (q - 1 + n) % n, pp = (q + 2) % n;
        nx[o] = (9 * (xs[q] + xs[p2]) - xs[pm] - xs[pp]) / 16; ny[o++] = (9 * (ys[q] + ys[p2]) - ys[pm] - ys[pp]) / 16;
      }
    }
    c.x = nx; c.y = ny;
  }
  function perimeter(c) {
    var s = 0, n = c.x.length;
    for (var q = 0; q < n; q++) { var p = (q + 1) % n, dx = c.x[p] - c.x[q], dy = c.y[p] - c.y[q]; s += Math.sqrt(dx * dx + dy * dy); }
    return s;
  }
  function trace(g, c, scale) {
    var xs = c.x, ys = c.y;
    g.beginPath(); g.moveTo(xs[0] * scale, ys[0] * scale);
    for (var q = 1; q < xs.length; q++) g.lineTo(xs[q] * scale, ys[q] * scale);
    g.closePath();
  }

  // ----- stage 3: advection + diffusion on a grid -----
  function sampleGrid(F, x, y) {
    var gx = Math.max(0, Math.min(G - 1.001, x * G - 0.5)), gy = Math.max(0, Math.min(G - 1.001, y * G - 0.5));
    var i = gx | 0, j = gy | 0, fx = gx - i, fy = gy - j, k = j * G + i;
    return F[k] * (1 - fx) * (1 - fy) + F[k + 1] * fx * (1 - fy) + F[k + G] * (1 - fx) * fy + F[k + G + 1] * fx * fy;
  }
  function rasterise(c, F) {                    // fraction of each grid cell covered by a droplet
    offCtx.setTransform(1, 0, 0, 1, 0, 0);
    offCtx.clearRect(0, 0, G, G);
    offCtx.fillStyle = "#fff"; trace(offCtx, c, G); offCtx.fill();
    var d = offCtx.getImageData(0, 0, G, G).data;
    for (var k = 0; k < G * G; k++) F[k] = d[k * 4 + 3] / 255;
  }
  function variance(F) {
    var n = 0, s = 0, s2 = 0;
    for (var k = 0; k < G * G; k += 3) { s += F[k]; s2 += F[k] * F[k]; n++; }
    var m = s / n; return s2 / n - m * m;
  }
  function startDiffusion() {
    rasterise(red, R); rasterise(cyan, C);
    diffusing = true;
  }
  function diffuseStep() {
    var k, i, j;
    if (stirring()) {
      for (j = 0; j < G; j++) for (i = 0; i < G; i++) {
        var x = (i + 0.5) / G, y = (j + 0.5) / G, v = velocity(x, y), u1 = v[0], v1 = v[1];
        v = velocity(x - 0.5 * u1, y - 0.5 * v1);
        k = j * G + i; R2[k] = sampleGrid(R, x - v[0], y - v[1]); C2[k] = sampleGrid(C, x - v[0], y - v[1]);
      }
      R.set(R2); C.set(C2);
    }
    var D = 0.045;                              // slow enough to watch the sheets blur
    for (var rep = 0; rep < 2; rep++) {
      for (j = 0; j < G; j++) for (i = 0; i < G; i++) {
        k = j * G + i;
        var l = i > 0 ? k - 1 : k, rr = i < G - 1 ? k + 1 : k, u = j > 0 ? k - G : k, d = j < G - 1 ? k + G : k;
        R2[k] = R[k] + D * (R[l] + R[rr] + R[u] + R[d] - 4 * R[k]);
        C2[k] = C[k] + D * (C[l] + C[rr] + C[u] + C[d] - 4 * C[k]);
      }
      R.set(R2); C.set(C2);
    }
  }

  // ----- drawing -----
  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!diffusing) {
      ctx.fillStyle = COL.bg; ctx.fillRect(0, 0, PX, PX);
      ctx.filter = "blur(" + (PX / 420).toFixed(2) + "px)";            // a soft dye edge
      ctx.fillStyle = COL.red; trace(ctx, red, PX); ctx.fill();
      ctx.fillStyle = COL.cyan; trace(ctx, cyan, PX); ctx.fill();
      ctx.filter = "none";
    } else {
      var od = offImg.data;
      for (var k = 0; k < G * G; k++) {
        var r = R[k], c = C[k], t = r + c;
        if (t > 1) { r /= t; c /= t; }                              // never brighter than the pure dyes
        var b = Math.max(0, 1 - r - c), o = k * 4;
        od[o] = 16 * b + 235 * r + 40 * c; od[o + 1] = 18 * b + 55 * r + 220 * c; od[o + 2] = 24 * b + 40 * r + 230 * c; od[o + 3] = 255;
      }
      offCtx.putImageData(offImg, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(off, 0, 0, PX, PX);
    }
  }

  // ----- lesson steps -----
  function show(n) {
    stage = n;
    steps.forEach(function (s) { s.hidden = +s.dataset.step !== n; });
    dots.forEach(function (li, q) { li.classList.toggle("done", q < n - 1); li.classList.toggle("now", q === n - 1); });
    root.classList.toggle("can-stir", n === 2 || n === 3);
  }
  function reset() {
    makeDroplets();
    diffusing = false; auto = false; autoT = 0; capped = false; capNote.hidden = true;
    btnAuto.forEach(function (b) { b.classList.remove("on"); });
    len0 = perimeter(red) + perimeter(cyan);
    stretchOut.textContent = "×1.0"; unmixedOut.textContent = "100%"; unmixedBar.style.width = "100%";
    btnNext2.disabled = true; btnNext3.disabled = true;
    show(1); draw();
  }
  root.addEventListener("click", function (e) {
    var go = e.target.closest("[data-go]"), a = e.target.closest("[data-auto]"), again = e.target.closest("[data-reset]");
    if (go) {
      var n = +go.dataset.go;
      if (n === 3) {
        var r0 = blob(0.62, 0.36, function () { return 0.2; }, 500);  // reference: the unstirred droplet
        rasterise(r0, R); var0 = variance(R);
        startDiffusion();
      }
      show(n);
    }
    if (a) { auto = !auto; btnAuto.forEach(function (b) { b.classList.toggle("on", auto); }); }
    if (again) reset();
  });

  function toUnit(e) {
    var r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  }
  canvas.addEventListener("pointerdown", function (e) {
    if (stage === 1) show(2);
    if (stage !== 2 && stage !== 3) return;
    pointer = lastPointer = toUnit(e); canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", function (e) { if (pointer) pointer = toUnit(e); });
  function up() { pointer = lastPointer = null; }
  canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);

  function resize() {
    PX = Math.min(480, Math.round(canvas.clientWidth * Math.min(2, window.devicePixelRatio || 1)));
    canvas.width = canvas.height = PX;
    off.width = off.height = G; offImg = offCtx.createImageData(G, G);
    if (red) draw();
  }

  function loop() {
    if (visible && (stage === 2 || stage === 3)) {
      var moving = stirring();
      if (!diffusing && moving) {
        advectCurve(red); advectCurve(cyan);
        refine(red); refine(cyan);
        draw();
      }
      if (diffusing) { diffuseStep(); draw(); }
      if (auto) autoT++;
      if (pointer) lastPointer = pointer;
      if (++frame % 10 === 0) {
        if (!diffusing && moving) {
          var st = (perimeter(red) + perimeter(cyan)) / len0;
          stretchOut.textContent = "×" + (st < 10 ? st.toFixed(1) : Math.round(st));
          if (st >= 4) btnNext2.disabled = false;
          if (st >= STRETCH_MAX) {                  // enough: sheets are thinner than the screen can show
            capped = true; auto = false; capNote.hidden = false;
            btnAuto.forEach(function (b) { b.classList.remove("on"); });
          }
        }
        if (diffusing) {
          var u = Math.max(0, Math.min(1, variance(R) / var0));
          unmixedOut.textContent = Math.round(u * 100) + "%";
          unmixedBar.style.width = Math.round(u * 100) + "%";
          if (u < 0.3) btnNext3.disabled = false;
        }
      }
    }
    requestAnimationFrame(loop);
  }

  if ("IntersectionObserver" in window) new IntersectionObserver(function (e) { visible = e[0].isIntersecting; }).observe(canvas);
  window.addEventListener("resize", resize);
  resize(); reset();
  requestAnimationFrame(loop);
})();
