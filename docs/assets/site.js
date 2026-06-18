// Docs interactivity (no dependencies): mobile nav, live API-base substitution,
// and copy-to-clipboard buttons on code blocks.
(function () {
  function ready(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }

  // ---- mobile nav -------------------------------------------------------
  function mobileNav() {
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
    document.querySelectorAll(".nav a").forEach(function (a) {
      a.addEventListener("click", function () { if (window.innerWidth <= 900) toggle(false); });
    });
  }

  // ---- live API base ----------------------------------------------------
  // The docs ship with a placeholder API URL. When these pages are SERVED BY a
  // running Drop instance, the API injects window.__DROP_API_ORIGIN__ with its
  // own origin (via /docs/drop-served.js, which the app overrides). We then
  // rewrite the placeholder to that origin — so the install one-liner, DROP_API,
  // and the MCP config point at the real, working server.
  //
  // This is OPT-IN by design: we rewrite only when the serving app explicitly
  // announced its origin, never inferred from location.hostname. So on any
  // static host — GitHub Pages (including custom domains), Netlify, file://, … —
  // the global is unset and the documented placeholder is preserved verbatim.
  var PLACEHOLDER = "https://api.drop.example.com";
  function rewriteApiBase() {
    var origin = window.__DROP_API_ORIGIN__;
    if (typeof origin !== "string" || !origin || origin === PLACEHOLDER) return;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var hits = [];
    while (walker.nextNode()) {
      if (walker.currentNode.nodeValue.indexOf(PLACEHOLDER) !== -1) hits.push(walker.currentNode);
    }
    hits.forEach(function (n) { n.nodeValue = n.nodeValue.split(PLACEHOLDER).join(origin); });
  }

  // ---- copy buttons -----------------------------------------------------
  function addCopyButtons() {
    if (!navigator.clipboard) return;
    document.querySelectorAll("article pre").forEach(function (pre) {
      if (pre.querySelector(".copy-btn")) return;
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "copy-btn";
      btn.textContent = "copy";
      btn.addEventListener("click", function () {
        var code = pre.querySelector("code") || pre;
        var text = code.innerText.replace(/\s+$/, "");
        navigator.clipboard.writeText(text).then(
          function () { flash("copied"); },
          function () { flash("press ⌘C"); }
        );
        function flash(msg) { btn.textContent = msg; setTimeout(function () { btn.textContent = "copy"; }, 1400); }
      });
      pre.classList.add("has-copy");
      pre.appendChild(btn);
    });
  }

  ready(function () {
    mobileNav();
    rewriteApiBase();   // before copy buttons, so copied text already has the real origin
    addCopyButtons();
  });
})();
