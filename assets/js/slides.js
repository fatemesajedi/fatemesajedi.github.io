// Fading photo slideshows (several photos in one spot). Dots switch photos;
// they advance by themselves unless the visitor prefers reduced motion.
(function () {
  var calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.querySelectorAll("[data-slides]").forEach(function (box, n) {
    var imgs = box.querySelectorAll("img"), dots = box.querySelectorAll(".slide-dots button"), i = 0, hover = false;
    function show(k) {
      i = (k + imgs.length) % imgs.length;
      imgs.forEach(function (im, q) { im.classList.toggle("on", q === i); });
      dots.forEach(function (d, q) { d.classList.toggle("on", q === i); });
    }
    dots.forEach(function (d, q) { d.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); show(q); }); });
    box.addEventListener("mouseenter", function () { hover = true; });
    box.addEventListener("mouseleave", function () { hover = false; });
    if (!calm) setTimeout(function () { setInterval(function () { if (!hover && !document.hidden) show(i + 1); }, 3800); }, n * 700);
  });
})();
