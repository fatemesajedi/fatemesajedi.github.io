// Fading slideshows (several photos in one spot). Dots switch slides;
// they advance by themselves unless the visitor prefers reduced motion.
// A slide is either an <img> or a <figure class="slide"> (image + caption).
(function () {
  var calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.querySelectorAll("[data-slides]").forEach(function (box, n) {
    var items = [].filter.call(box.children, function (el) { return el.tagName === "IMG" || el.classList.contains("slide"); });
    var dots = box.querySelectorAll(".slide-dots button"), i = 0, hover = false;
    if (items.length < 2) return;
    function show(k) {
      i = (k + items.length) % items.length;
      items.forEach(function (el, q) { el.classList.toggle("on", q === i); });
      dots.forEach(function (d, q) { d.classList.toggle("on", q === i); });
    }
    dots.forEach(function (d, q) { d.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); show(q); }); });
    box.addEventListener("mouseenter", function () { hover = true; });
    box.addEventListener("mouseleave", function () { hover = false; });
    if (!calm) setTimeout(function () { setInterval(function () { if (!hover && !document.hidden) show(i + 1); }, 4500); }, n * 700);
  });
})();
