// A tiny "porous medium" toy: two solutes (A, B) flow between grains, mix,
// and react (A + B -> C) when they meet. Move the mouse over it to stir.
(function () {
  var canvas = document.getElementById("mixing-canvas");
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext("2d");
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var W, H, dpr, grains = [], particles = [], mouse = null, running = true;
  var N_PARTICLES = 320, U = 0.9, DIFF = 0.35, REACT_DIST = 7;

  function colors() {
    var s = getComputedStyle(document.documentElement);
    return {
      grain: s.getPropertyValue("--grain").trim() || "#d9dee2",
      A: s.getPropertyValue("--species-a").trim() || "#0e7c86",
      B: s.getPropertyValue("--species-b").trim() || "#e8833a",
      C: s.getPropertyValue("--species-c").trim() || "#8b5cf6"
    };
  }
  var col = colors();

  function resize() {
    dpr = window.devicePixelRatio || 1;
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    makeGrains();
    particles = [];
    for (var i = 0; i < N_PARTICLES; i++) particles.push(spawn(Math.random() * W));
  }

  function makeGrains() {
    grains = [];
    var target = Math.round((W * H) / 5200), tries = 0;
    while (grains.length < target && tries < 4000) {
      tries++;
      var r = 10 + Math.random() * 22;
      var g = { x: 40 + Math.random() * (W - 40), y: Math.random() * H, r: r };
      var ok = true;
      for (var j = 0; j < grains.length; j++) {
        var o = grains[j], dx = o.x - g.x, dy = o.y - g.y;
        if (dx * dx + dy * dy < Math.pow(o.r + g.r + 9, 2)) { ok = false; break; }
      }
      if (ok) grains.push(g);
    }
  }

  function insideGrain(x, y) {
    for (var j = 0; j < grains.length; j++) {
      var g = grains[j], dx = x - g.x, dy = y - g.y;
      if (dx * dx + dy * dy < g.r * g.r) return true;
    }
    return false;
  }

  function spawn(x) {
    var y, tries = 0;
    do { y = Math.random() * H; tries++; } while (insideGrain(x, y) && tries < 20);
    return { x: x, y: y, s: y < H / 2 ? "A" : "B" };
  }

  function step() {
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i], vx = U, vy = 0;
      // flow deflects around grains
      for (var j = 0; j < grains.length; j++) {
        var g = grains[j], dx = p.x - g.x, dy = p.y - g.y, d2 = dx * dx + dy * dy;
        var reach = g.r * 2.2;
        if (d2 < reach * reach) {
          var d = Math.sqrt(d2) || 1, nx = dx / d, ny = dy / d;
          var w = 1 - (d - g.r) / (reach - g.r);
          if (w > 0) {
            var vn = vx * nx + vy * ny;          // remove velocity into the grain
            if (vn < 0) { vx -= vn * nx * w; vy -= vn * ny * w; }
          }
          if (d < g.r) { p.x = g.x + nx * g.r; p.y = g.y + ny * g.r; }
        }
      }
      // mouse stirring
      if (mouse) {
        var mx = p.x - mouse.x, my = p.y - mouse.y, md2 = mx * mx + my * my;
        if (md2 < 4900) { var m = (1 - md2 / 4900) * 2.2; vx += -my / 70 * m; vy += mx / 70 * m; }
      }
      p.x += vx + (Math.random() - 0.5) * DIFF * 2;
      p.y += vy + (Math.random() - 0.5) * DIFF * 2;
      if (p.y < 0) p.y += H;
      if (p.y > H) p.y -= H;
      if (p.x > W + 4) particles[i] = spawn(-4);
    }
    // reactions: A + B -> C (simple grid search)
    var cell = REACT_DIST, grid = {};
    for (var k = 0; k < particles.length; k++) {
      var q = particles[k];
      if (q.s === "C") continue;
      var key = ((q.x / cell) | 0) + "," + ((q.y / cell) | 0);
      (grid[key] = grid[key] || []).push(q);
    }
    for (var key2 in grid) {
      var parts = key2.split(","), cx = +parts[0], cy = +parts[1], list = grid[key2];
      for (var a = 0; a < list.length; a++) {
        var pa = list[a];
        if (pa.s === "C") continue;
        for (var ox = -1; ox <= 1; ox++) for (var oy = -1; oy <= 1; oy++) {
          var nb = grid[(cx + ox) + "," + (cy + oy)];
          if (!nb) continue;
          for (var b = 0; b < nb.length; b++) {
            var pb = nb[b];
            if (pb.s === "C" || pb.s === pa.s) continue;
            var ddx = pa.x - pb.x, ddy = pa.y - pb.y;
            if (ddx * ddx + ddy * ddy < REACT_DIST * REACT_DIST && Math.random() < 0.5) {
              pa.s = "C"; pb.s = "C"; pa.flash = 12;
            }
          }
        }
      }
    }
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = col.grain;
    for (var j = 0; j < grains.length; j++) {
      var g = grains[j];
      ctx.beginPath(); ctx.arc(g.x, g.y, g.r, 0, Math.PI * 2); ctx.fill();
    }
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      ctx.fillStyle = col[p.s];
      var r = p.s === "C" ? 2.6 : 2.1;
      if (p.flash) { r += p.flash / 4; ctx.globalAlpha = 0.5; p.flash--; }
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  function loop() {
    if (running) { step(); draw(); }
    requestAnimationFrame(loop);
  }

  canvas.addEventListener("pointermove", function (e) {
    var rect = canvas.getBoundingClientRect();
    mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  });
  canvas.addEventListener("pointerleave", function () { mouse = null; });

  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) { running = entries[0].isIntersecting; }).observe(canvas);
  }
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () { col = colors(); });
  var rt;
  window.addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(function () { resize(); draw(); }, 200); });

  resize();
  if (reduceMotion) {
    // "Reduce motion" is on: show a still picture, animate only once the visitor reaches for it
    for (var s = 0; s < 400; s++) step();
    draw();
    var started = false;
    canvas.addEventListener("pointerdown", start);
    canvas.addEventListener("pointerenter", start);
    function start() { if (!started) { started = true; loop(); } }
  } else {
    loop();
  }
})();
