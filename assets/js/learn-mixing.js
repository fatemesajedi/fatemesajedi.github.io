// "Let's learn mixing together": two droplets, stirred then diffused.
// Stage "stir": pure advection, computed with a backward flow map X(x) (where each
// point came from), so filaments stay perfectly sharp (no numerical diffusion).
// Stage "diffuse": the field is handed to a grid and advection + diffusion act together.
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

  var M = 192;                       // flow-map grid
  var G = 220;                       // grid for the diffusion stage
  var MX = new Float32Array((M + 1) * (M + 1)), MY = new Float32Array((M + 1) * (M + 1));
  var TX = new Float32Array(MX.length), TY = new Float32Array(MX.length);
  var R = new Float32Array(G * G), C = new Float32Array(G * G), R2 = new Float32Array(G * G), C2 = new Float32Array(G * G);
  var stage = 1, diffusing = false, auto = false, autoT = 0, pointer = null, lastPointer = null;
  var len0 = 1, var0 = 1, frame = 0, S, PX, img, visible = true;
  var off = document.createElement("canvas"), offCtx = off.getContext("2d");

  // ----- the two droplets (soft-edged, like the dye blobs in the classic picture) -----
  function smooth(e0, e1, x) { var t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }
  function red0(x, y) {
    var dx = x - 0.62, dy = y - 0.36;
    return smooth(0.215, 0.185, Math.sqrt(dx * dx + dy * dy));
  }
  function cyan0(x, y) {
    var dx = x - 0.36, dy = y - 0.62, a = Math.atan2(dy, dx);
    var r = 0.165 + 0.018 * Math.sin(2 * a + 0.6) + 0.01 * Math.sin(3 * a);   // a slightly lumpy blob
    return smooth(r + 0.016, r - 0.016, Math.sqrt(dx * dx + dy * dy));
  }

  // ----- stirring flow (stream function, zero at the walls) -----
  function wall(t) { var s = 2 * t - 1; return [1 - Math.pow(s, 8), -16 * Math.pow(s, 7)]; }   // value, derivative
  function velocity(x, y) {
    var u = 0, v = 0, wx = wall(x), wy = wall(y), W = wx[0] * wy[0], Wx = wx[1] * wy[0], Wy = wx[0] * wy[1];
    if (pointer && lastPointer) {                 // a "spoon" dragged by the visitor
      var dx = pointer.x - lastPointer.x, dy = pointer.y - lastPointer.y;
      var l = Math.sqrt(dx * dx + dy * dy); if (l > 0.03) { dx *= 0.03 / l; dy *= 0.03 / l; }
      var rx = x - pointer.x, ry = y - pointer.y, s2 = 0.09 * 0.09, g = Math.exp(-(rx * rx + ry * ry) / (2 * s2));
      var Sv = dx * ry - dy * rx, psi = Sv * g;
      var psiX = -dy * g + Sv * (-rx / s2) * g, psiY = dx * g + Sv * (-ry / s2) * g;
      u += psiY * W + psi * Wy; v -= psiX * W + psi * Wx;
    }
    if (auto) {                                   // alternating cellular flows = chaotic stirring
      var A = 0.0042, ph = Math.floor(autoT / 70) % 3, P = Math.PI;
      if (ph === 0) { u += A * P * Math.sin(P * x) * Math.cos(P * y); v -= A * P * Math.cos(P * x) * Math.sin(P * y); }
      else if (ph === 1) { u += A * P * Math.sin(2 * P * x) * Math.cos(P * y); v -= 2 * A * P * Math.cos(2 * P * x) * Math.sin(P * y); }
      else { u += 2 * A * P * Math.sin(P * x) * Math.cos(2 * P * y); v -= A * P * Math.cos(P * x) * Math.sin(2 * P * y); }
    }
    return [u, v];
  }
  function stirring() { return auto || (pointer && lastPointer && (pointer.x !== lastPointer.x || pointer.y !== lastPointer.y)); }

  // ----- stage 2: advect the backward map -----
  function sampleMap(F, x, y) {
    var gx = Math.max(0, Math.min(M - 1e-4, x * M)), gy = Math.max(0, Math.min(M - 1e-4, y * M));
    var i = gx | 0, j = gy | 0, fx = gx - i, fy = gy - j, k = j * (M + 1) + i;
    return F[k] * (1 - fx) * (1 - fy) + F[k + 1] * fx * (1 - fy) + F[k + M + 1] * (1 - fx) * fy + F[k + M + 2] * fx * fy;
  }
  function advectMap() {
    for (var j = 0; j <= M; j++) for (var i = 0; i <= M; i++) {
      var x = i / M, y = j / M, v1 = velocity(x, y), v2 = velocity(x - 0.5 * v1[0], y - 0.5 * v1[1]);
      var dx = x - v2[0], dy = y - v2[1], k = j * (M + 1) + i;
      TX[k] = sampleMap(MX, dx, dy); TY[k] = sampleMap(MY, dx, dy);
    }
    MX.set(TX); MY.set(TY);
  }

  // ----- stage 3: advection + diffusion on a grid -----
  function sampleGrid(F, x, y) {
    var gx = Math.max(0, Math.min(G - 1.001, x * G - 0.5)), gy = Math.max(0, Math.min(G - 1.001, y * G - 0.5));
    var i = gx | 0, j = gy | 0, fx = gx - i, fy = gy - j, k = j * G + i;
    return F[k] * (1 - fx) * (1 - fy) + F[k + 1] * fx * (1 - fy) + F[k + G] * (1 - fx) * fy + F[k + G + 1] * fx * fy;
  }
  function startDiffusion() {
    for (var j = 0; j < G; j++) for (var i = 0; i < G; i++) {
      var r = 0, c = 0;
      for (var sy = 0; sy < 3; sy++) for (var sx = 0; sx < 3; sx++) {
        var x = (i + (sx + 0.5) / 3) / G, y = (j + (sy + 0.5) / 3) / G, X = sampleMap(MX, x, y), Y = sampleMap(MY, x, y);
        r += red0(X, Y); c += cyan0(X, Y);
      }
      R[j * G + i] = r / 9; C[j * G + i] = c / 9;
    }
    diffusing = true;
  }
  function diffuseStep() {
    var k, i, j;
    if (stirring()) {
      for (j = 0; j < G; j++) for (i = 0; i < G; i++) {
        var x = (i + 0.5) / G, y = (j + 0.5) / G, v1 = velocity(x, y), v2 = velocity(x - 0.5 * v1[0], y - 0.5 * v1[1]);
        k = j * G + i; R2[k] = sampleGrid(R, x - v2[0], y - v2[1]); C2[k] = sampleGrid(C, x - v2[0], y - v2[1]);
      }
      R.set(R2); C.set(C2);
    }
    var D = 0.11;
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

  // ----- measurements -----
  function interfaceLength() {                    // count cell edges where the red dye crosses 1/2
    var n = 150, prev = new Float32Array(n), cur = new Float32Array(n), cnt = 0;
    for (var j = 0; j < n; j++) {
      for (var i = 0; i < n; i++) {
        var x = (i + 0.5) / n, y = (j + 0.5) / n;
        var v = diffusing ? sampleGrid(R, x, y) : red0(sampleMap(MX, x, y), sampleMap(MY, x, y));
        cur[i] = v;
        if (i > 0 && (v > 0.5) !== (cur[i - 1] > 0.5)) cnt++;
        if (j > 0 && (v > 0.5) !== (prev[i] > 0.5)) cnt++;
      }
      var t = prev; prev = cur; cur = t;
    }
    return cnt;
  }
  function unmixedness() {                        // variance of the red dye, relative to the start
    var n = 0, s = 0, s2 = 0;
    for (var k = 0; k < G * G; k += 3) { s += R[k]; s2 += R[k] * R[k]; n++; }
    var m = s / n; return (s2 / n - m * m);
  }

  // ----- drawing -----
  var BG = [16, 18, 24], RED = [235, 55, 40], CYAN = [40, 220, 230];
  function paint(d, o, r, c) {
    r = Math.min(1, r); c = Math.min(1, c);
    var e = 1 - Math.max(0, r + c - 1) * 0.5;
    d[o] = BG[0] * (1 - r - c > 0 ? 1 - r - c : 0) + (RED[0] * r + CYAN[0] * c) * e;
    d[o + 1] = BG[1] * (1 - r - c > 0 ? 1 - r - c : 0) + (RED[1] * r + CYAN[1] * c) * e;
    d[o + 2] = BG[2] * (1 - r - c > 0 ? 1 - r - c : 0) + (RED[2] * r + CYAN[2] * c) * e;
    d[o + 3] = 255;
  }
  function draw() {
    if (!diffusing) {
      var d = img.data;
      for (var py = 0; py < PX; py++) for (var px = 0; px < PX; px++) {
        var x = (px + 0.5) / PX, y = (py + 0.5) / PX, X = sampleMap(MX, x, y), Y = sampleMap(MY, x, y);
        paint(d, (py * PX + px) * 4, red0(X, Y), cyan0(X, Y));
      }
      ctx.putImageData(img, 0, 0);
    } else {
      var od = offImg.data;
      for (var k = 0; k < G * G; k++) paint(od, k * 4, R[k], C[k]);
      offCtx.putImageData(offImg, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(off, 0, 0, PX, PX);
    }
  }
  var offImg;

  // ----- lesson steps -----
  function show(n) {
    stage = n;
    steps.forEach(function (s) { s.hidden = +s.dataset.step !== n; });
    dots.forEach(function (li, q) { li.classList.toggle("done", q < n - 1); li.classList.toggle("now", q === n - 1); });
    root.classList.toggle("can-stir", n === 2 || n === 3);
  }
  function reset() {
    for (var j = 0; j <= M; j++) for (var i = 0; i <= M; i++) { MX[j * (M + 1) + i] = i / M; MY[j * (M + 1) + i] = j / M; }
    diffusing = false; auto = false; autoT = 0;
    btnAuto.forEach(function (b) { b.classList.remove("on"); });
    len0 = interfaceLength();
    stretchOut.textContent = "×1.0"; unmixedOut.textContent = "100%"; unmixedBar.style.width = "100%";
    btnNext2.disabled = true; btnNext3.disabled = true;
    show(1); draw();
  }
  root.addEventListener("click", function (e) {
    var go = e.target.closest("[data-go]"), a = e.target.closest("[data-auto]"), again = e.target.closest("[data-reset]");
    if (go) {
      var n = +go.dataset.go;
      if (n === 3) {
        startDiffusion();
        var s = 0, s2 = 0, cnt = 0;            // reference variance: the unstirred droplets
        for (var j = 0; j < G; j++) for (var i = 0; i < G; i += 3) { var v = red0((i + 0.5) / G, (j + 0.5) / G); s += v; s2 += v * v; cnt++; }
        var m = s / cnt; var0 = s2 / cnt - m * m;
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
    S = canvas.clientWidth;
    PX = Math.min(420, Math.round(S * Math.min(2, window.devicePixelRatio || 1)));
    canvas.width = canvas.height = PX;
    img = ctx.createImageData(PX, PX);
    off.width = off.height = G; offImg = offCtx.createImageData(G, G);
    draw();
  }

  function loop() {
    if (visible && (stage === 2 || stage === 3)) {
      var moving = stirring();
      if (!diffusing && moving) { advectMap(); draw(); }
      if (diffusing) { diffuseStep(); draw(); }
      if (auto) autoT++;
      if (pointer) lastPointer = pointer;
      if (++frame % 12 === 0) {
        if (!diffusing && moving) {
          var st = interfaceLength() / len0;
          stretchOut.textContent = "×" + st.toFixed(1);
          if (st >= 4) btnNext2.disabled = false;
        }
        if (diffusing) {
          var u = Math.max(0, Math.min(1, unmixedness() / var0));
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
