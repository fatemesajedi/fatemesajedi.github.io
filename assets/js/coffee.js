// Interactive coffee cup: milk is poured in, visitors stir it with a spoon,
// and a meter shows how well mixed the cup is.
(function () {
  var canvas = document.getElementById("coffee-canvas");
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext("2d");
  var meterFill = document.getElementById("mix-meter-fill");
  var meterText = document.getElementById("mix-meter-value");
  var hint = document.getElementById("coffee-hint");
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var G = 64;                     // simulation grid (G x G over the cup)
  var N = 2600;                   // milk particles
  var S, R, CX, CY, dpr;          // canvas size, cup radius, centre
  var vx = new Float32Array(G * G), vy = new Float32Array(G * G);
  var tmpx = new Float32Array(G * G), tmpy = new Float32Array(G * G);
  var dens = new Float32Array(G * G), tmpd = new Float32Array(G * G);
  var inside = new Uint8Array(G * G), insideCount = 0;
  var px = new Float32Array(N), py = new Float32Array(N), count = 0;
  var pouring = 0, pourX = 0, pourY = 0;
  var spoon = null, lastSpoon = null, interacted = false;
  var cv0 = 0, visible = true, poured = false;

  var off = document.createElement("canvas");
  off.width = off.height = G;
  var offCtx = off.getContext("2d");
  var img = offCtx.createImageData(G, G);

  // coffee -> latte -> cream
  var C0 = [52, 30, 17], C1 = [190, 142, 92], C2 = [250, 243, 232];

  function resize() {
    dpr = window.devicePixelRatio || 1;
    S = canvas.clientWidth;
    canvas.width = canvas.height = S * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    CX = S * 0.47; CY = S * 0.5; R = S * 0.36;
  }

  function setupGrid() {
    insideCount = 0;
    for (var j = 0; j < G; j++) for (var i = 0; i < G; i++) {
      var x = (i + 0.5) / G * 2 - 1, y = (j + 0.5) / G * 2 - 1;
      var k = j * G + i;
      inside[k] = x * x + y * y < 0.97 ? 1 : 0;
      insideCount += inside[k];
    }
  }

  // particle positions are in grid units [0, G)
  function newCup() {
    count = 0; cv0 = 0;
    vx.fill(0); vy.fill(0);
    pour();
  }

  function pour() {
    if (count >= N) { count = 0; cv0 = 0; }
    var a = Math.random() * Math.PI * 2, r = Math.random() * 0.35;
    pourX = G / 2 + Math.cos(a) * r * G / 2;
    pourY = G / 2 + Math.sin(a) * r * G / 2;
    pouring = Math.min(N - count, 1300);
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

  function step() {
    // pouring milk in, with a little outward splash
    if (pouring > 0) {
      var n = Math.min(pouring, 45);
      for (var q = 0; q < n; q++) {
        var a = Math.random() * Math.PI * 2, rr = Math.random() * 2.2;
        px[count] = pourX + Math.cos(a) * rr;
        py[count] = pourY + Math.sin(a) * rr;
        count++;
      }
      pouring -= n;
      var pi = Math.round(pourX), pj = Math.round(pourY);
      for (var dj = -5; dj <= 5; dj++) for (var di = -5; di <= 5; di++) {
        var d = Math.sqrt(di * di + dj * dj);
        if (d === 0 || d > 5) continue;
        var kk = (pj + dj) * G + (pi + di);
        if (kk >= 0 && kk < G * G) { vx[kk] += di / d * 0.012; vy[kk] += dj / d * 0.012; }
      }
    }

    // spoon pushes the coffee
    if (spoon && lastSpoon) {
      var dx = spoon.x - lastSpoon.x, dy = spoon.y - lastSpoon.y;
      var gx = spoon.x, gy = spoon.y, rad = 4.5;
      for (var j = Math.max(0, (gy - rad) | 0); j < Math.min(G, gy + rad + 1); j++)
        for (var i = Math.max(0, (gx - rad) | 0); i < Math.min(G, gx + rad + 1); i++) {
          var ex = i + 0.5 - gx, ey = j + 0.5 - gy, w = 1 - Math.sqrt(ex * ex + ey * ey) / rad;
          if (w > 0) { var k = j * G + i; vx[k] += (dx - vx[k]) * w * 0.6; vy[k] += (dy - vy[k]) * w * 0.6; }
        }
    }
    lastSpoon = spoon;

    // smooth + slow down the flow; keep it inside the cup
    blur(vx, tmpx, 0.35); blur(vy, tmpy, 0.35);
    for (var k2 = 0; k2 < G * G; k2++) {
      if (!inside[k2]) { vx[k2] = vy[k2] = 0; continue; }
      vx[k2] *= 0.988; vy[k2] *= 0.988;
      var cx = (k2 % G) + 0.5 - G / 2, cy = ((k2 / G) | 0) + 0.5 - G / 2, r2 = cx * cx + cy * cy;
      if (r2 > (G * 0.43) * (G * 0.43)) {      // near the wall: slide along it
        var r = Math.sqrt(r2), nx = cx / r, ny = cy / r, vn = vx[k2] * nx + vy[k2] * ny;
        if (vn > 0) { vx[k2] -= vn * nx; vy[k2] -= vn * ny; }
      }
    }

    // move milk
    var lim = G / 2 * 0.97;
    for (var p = 0; p < count; p++) {
      var ux = sample(vx, px[p], py[p]), uy = sample(vy, px[p], py[p]);
      px[p] += ux + (Math.random() - 0.5) * 0.12;
      py[p] += uy + (Math.random() - 0.5) * 0.12;
      var ox = px[p] - G / 2, oy = py[p] - G / 2, od = Math.sqrt(ox * ox + oy * oy);
      if (od > lim) { px[p] = G / 2 + ox / od * lim; py[p] = G / 2 + oy / od * lim; }
    }
  }

  function render() {
    // milk concentration field
    dens.fill(0);
    for (var p = 0; p < count; p++) {
      var i = px[p] | 0, j = py[p] | 0;
      if (i >= 0 && i < G && j >= 0 && j < G) dens[j * G + i] += 1;
    }
    blur(dens, tmpd, 0.8); blur(dens, tmpd, 0.8);
    var full = N / insideCount;
    var d = img.data;
    for (var k = 0; k < G * G; k++) {
      var t = Math.min(1, dens[k] / (full * 2.3)), c;
      if (t < 0.43) { var a = t / 0.43; c = [C0[0] + (C1[0] - C0[0]) * a, C0[1] + (C1[1] - C0[1]) * a, C0[2] + (C1[2] - C0[2]) * a]; }
      else { var b = (t - 0.43) / 0.57; c = [C1[0] + (C2[0] - C1[0]) * b, C1[1] + (C2[1] - C1[1]) * b, C1[2] + (C2[2] - C1[2]) * b]; }
      d[k * 4] = c[0]; d[k * 4 + 1] = c[1]; d[k * 4 + 2] = c[2]; d[k * 4 + 3] = 255;
    }
    offCtx.putImageData(img, 0, 0);

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
    ctx.drawImage(off, CX - R, CY - R, R * 2, R * 2);
    var shine = ctx.createRadialGradient(CX - R * 0.4, CY - R * 0.45, 0, CX - R * 0.4, CY - R * 0.45, R * 0.9);
    shine.addColorStop(0, "rgba(255,255,255,.16)"); shine.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = shine; ctx.fillRect(CX - R, CY - R, R * 2, R * 2);
    var edge = ctx.createRadialGradient(CX, CY, R * 0.75, CX, CY, R);
    edge.addColorStop(0, "rgba(0,0,0,0)"); edge.addColorStop(1, "rgba(0,0,0,.28)");
    ctx.fillStyle = edge; ctx.fillRect(CX - R, CY - R, R * 2, R * 2);
    ctx.restore();

    // milk stream while pouring
    if (pouring > 0) {
      var sx = CX + (pourX / G * 2 - 1) * R, sy = CY + (pourY / G * 2 - 1) * R;
      ctx.strokeStyle = "rgba(250,245,236,.95)"; ctx.lineWidth = 5; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(sx - R * 0.5, -10); ctx.quadraticCurveTo(sx - R * 0.1, sy - R * 0.6, sx, sy); ctx.stroke();
    }

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

  function updateMeter() {
    // coarse grid (8x8 cells inside the cup) -> coefficient of variation
    var B = 8, cells = new Float32Array(B * B), used = 0, sum = 0, sum2 = 0;
    for (var p = 0; p < count; p++) {
      var i = (px[p] / G * B) | 0, j = (py[p] / G * B) | 0;
      if (i >= 0 && i < B && j >= 0 && j < B) cells[j * B + i]++;
    }
    var vals = [];
    for (var cj = 0; cj < B; cj++) for (var ci = 0; ci < B; ci++) {
      var x = (ci + 0.5) / B * 2 - 1, y = (cj + 0.5) / B * 2 - 1;
      if (x * x + y * y < 0.72) vals.push(cells[cj * B + ci]);
    }
    for (var v = 0; v < vals.length; v++) { sum += vals[v]; sum2 += vals[v] * vals[v]; }
    var mean = sum / vals.length;
    if (!count || mean === 0) { meterFill.style.width = "0%"; meterText.textContent = "0%"; return; }
    var cv = Math.sqrt(Math.max(0, sum2 / vals.length - mean * mean)) / mean;
    if (cv > cv0) cv0 = cv;
    var floor = 1 / Math.sqrt(mean);   // random noise level = "perfectly mixed"
    var m = Math.max(0, Math.min(1, (cv0 - cv) / Math.max(0.01, cv0 - floor * 1.15)));
    var pct = Math.round(m * 100);
    meterFill.style.width = pct + "%";
    meterText.textContent = pct + "%";
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
    spoon = g;
    if (!interacted) { interacted = true; if (hint) hint.classList.add("gone"); }
  });
  canvas.addEventListener("pointerdown", function (e) { spoon = toGrid(e); lastSpoon = spoon; });
  canvas.addEventListener("pointerleave", function () { spoon = null; });
  canvas.addEventListener("pointerup", function (e) { if (e.pointerType !== "mouse") spoon = null; });

  document.getElementById("coffee-pour").addEventListener("click", function () { pour(); });
  document.getElementById("coffee-reset").addEventListener("click", function () { newCup(); });

  var frame = 0;
  function loop() {
    if (visible) {
      step(); render();
      if (++frame % 10 === 0) updateMeter();
    }
    requestAnimationFrame(loop);
  }

  resize(); setupGrid();
  window.addEventListener("resize", resize);

  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      if (visible && !poured) setTimeout(pour, 400);   // pour when the cup scrolls into view
    }, { threshold: 0.4 }).observe(canvas);
  } else {
    pour();
  }

  if (reduceMotion) {
    pour(); for (var s = 0; s < 40; s++) step();
    render(); updateMeter();
    visible = false;
  } else {
    loop();
  }
})();
