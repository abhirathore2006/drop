// Mobile nav toggle (no dependencies).
(function () {
  function ready(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }
  ready(function () {
    var sidebar = document.querySelector(".sidebar");
    var burger = document.querySelector(".hamburger");
    var scrim = document.querySelector(".scrim");
    function toggle(open) {
      if (!sidebar) return;
      sidebar.classList.toggle("open", open);
      if (scrim) scrim.classList.toggle("open", open);
    }
    if (burger) burger.addEventListener("click", function () { toggle(!sidebar.classList.contains("open")); });
    if (scrim) scrim.addEventListener("click", function () { toggle(false); });
    // close the drawer after following an in-page link on mobile
    document.querySelectorAll(".nav a").forEach(function (a) {
      a.addEventListener("click", function () { if (window.innerWidth <= 900) toggle(false); });
    });
  });
})();
