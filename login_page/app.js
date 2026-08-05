/* =========================================================================
   Dark "particle + wireframe globe" enterprise login  (front-end only)
   -------------------------------------------------------------------------
   EDIT ME: everything customizable lives in the CONFIG object below.
   All visuals are generated in code — there are NO image assets and NO
   vendor branding. The molecule logo is inline SVG in index.html; swap it,
   or restyle via CONFIG. The form never contacts a server: submit shows a
   fake "Signing in…" state, then a demo message.
   ========================================================================= */

const CONFIG = {
  /* ---- Brand ---- */
  brandName: "Network Controller",   // product name shown next to the logo
  brandTagline: "",                  // optional small line under brand (blank = hidden)

  /* ---- Theme ---- */
  accent: "#186FC2",                 // primary blue: button, links, focus, globe accents
  accentHover: "#1A7FD8",
  accentPress: "#135A9E",

  /* ---- Background constellation ---- */
  particleCount: 90,                 // number of drifting dots
  particleColor: "150,190,245",      // dot/line RGB (used with varying alpha)
  linkDistance: 130,                 // px: connect two dots closer than this
  mouseDistance: 180,                // px: draw a line from a dot to the cursor within this

  /* ---- Feature switches ---- */
  showGlobe: true,                   // left CSS-3D wireframe globe
  showVerifyCode: false,             // captcha field (default off for the dark look)
  defaultLang: "en",                 // "en" | "zh"

  /* ---- Footer (two lines) ---- */
  footer: {
    browser: {
      en: "Use Google Chrome 100+, Firefox 91.8 ESR / 99+, or Microsoft Edge 100+. Recommended resolution 1920 x 1080, minimum 1366 x 768.",
      zh: "建议使用 Google Chrome 100+、Firefox 91.8 ESR / 99+ 或 Microsoft Edge 100+。推荐分辨率 1920 x 1080，最低 1366 x 768。",
    },
    copyright: {
      en: "Copyright © 2015-2026 Network Controller. All rights reserved.",
      zh: "版权所有 © 2015-2026 Network Controller。保留一切权利。",
    },
  },

  /* ---- Localized UI text ---- */
  i18n: {
    en: {
      username: "Username",
      usernamePlaceholder: "Username",
      password: "Password",
      passwordPlaceholder: "Password",
      verifycode: "Verify Code",
      verifycodePlaceholder: "Verify code",
      remember: "Remember login username",
      forgot: "Forgot Password",
      login: "Log In",
      loggingIn: "Signing in…",
      capsOn: "Caps Lock is on",
      needUser: "Please enter your username.",
      needPass: "Please enter your password.",
      needCode: "Please enter the verify code.",
      badCode: "Verify code is incorrect.",
      demo: "Demo only — this is a front-end replica, no server is contacted.",
    },
    zh: {
      username: "用户名",
      usernamePlaceholder: "用户名",
      password: "密码",
      passwordPlaceholder: "密码",
      verifycode: "验证码",
      verifycodePlaceholder: "验证码",
      remember: "记住登录用户名",
      forgot: "忘记密码",
      login: "登 录",
      loggingIn: "正在登录…",
      capsOn: "大写锁定已开启",
      needUser: "请输入用户名。",
      needPass: "请输入密码。",
      needCode: "请输入验证码。",
      badCode: "验证码不正确。",
      demo: "仅为演示 — 这是纯前端复刻页面，不会连接任何服务器。",
    },
  },
};

/* ========================================================================= */
/*  Implementation — normally no need to edit below this line.               */
/* ========================================================================= */

(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let lang = CONFIG.defaultLang;
  let captchaText = "";

  /* ---- Theme variables ---- */
  function applyTheme() {
    const r = document.documentElement.style;
    r.setProperty("--accent", CONFIG.accent);
    r.setProperty("--accent-hover", CONFIG.accentHover);
    r.setProperty("--accent-press", CONFIG.accentPress);
  }

  /* ---- Localized text ---- */
  function applyLang(next) {
    lang = next;
    const t = CONFIG.i18n[lang];
    document.documentElement.lang = lang;

    $("brandName").textContent = CONFIG.brandName;
    $("lblUser").textContent = t.username;
    $("lblPass").textContent = t.password;
    $("lblCode").textContent = t.verifycode;
    $("lblRemember").textContent = t.remember;
    $("lblForgot").textContent = t.forgot;
    $("lblLogin").textContent = t.login;
    $("capsHint").title = t.capsOn;

    $("username").placeholder = t.usernamePlaceholder;
    $("password").placeholder = t.passwordPlaceholder;
    $("verifycode").placeholder = t.verifycodePlaceholder;

    $("footerBrowser").textContent = CONFIG.footer.browser[lang];
    $("footerCopyright").textContent = CONFIG.footer.copyright[lang];

    $("langEn").classList.toggle("is-active", lang === "en");
    $("langZh").classList.toggle("is-active", lang === "zh");
  }

  /* =======================================================================
     BACKGROUND CONSTELLATION (canvas) — drifting dots, links between near
     dots, and links reaching toward the mouse cursor. Damped via rAF.
     ======================================================================= */
  function initConstellation() {
    const canvas = $("fx");
    const ctx = canvas.getContext("2d");
    let W = 0, H = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
    const dots = [];
    const mouse = { x: -9999, y: -9999, active: false };
    const [pr, pg, pb] = CONFIG.particleColor.split(",").map(Number);
    const LINK = CONFIG.linkDistance, MDIST = CONFIG.mouseDistance;

    function resize() {
      // Fall back to the viewport if layout isn't measurable yet (avoids a 0-sized, blank canvas).
      W = canvas.clientWidth || window.innerWidth;
      H = canvas.clientHeight || window.innerHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function seed() {
      dots.length = 0;
      for (let i = 0; i < CONFIG.particleCount; i++) {
        dots.push({
          x: Math.random() * W, y: Math.random() * H,
          vx: (Math.random() - 0.5) * 0.28,
          vy: (Math.random() - 0.5) * 0.28,
          r: Math.random() * 1.6 + 0.6,
        });
      }
    }

    window.addEventListener("pointermove", (e) => { mouse.x = e.clientX; mouse.y = e.clientY; mouse.active = true; });
    window.addEventListener("pointerleave", () => { mouse.active = false; mouse.x = mouse.y = -9999; });
    // On resize we re-size (which clears the canvas) and reseed; when the animation
    // loop is frozen (reduced-motion) we must repaint the static frame here, otherwise
    // the canvas would stay blank after any resize.
    window.addEventListener("resize", () => { resize(); seed(); if (reduceMotion) frame(); });

    resize(); seed();

    function frame() {
      ctx.clearRect(0, 0, W, H);

      // move + draw dots
      for (const d of dots) {
        d.x += d.vx; d.y += d.vy;
        if (d.x < 0 || d.x > W) d.vx *= -1;
        if (d.y < 0 || d.y > H) d.vy *= -1;
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${pr},${pg},${pb},0.75)`;
        ctx.fill();
      }

      // links between nearby dots
      for (let i = 0; i < dots.length; i++) {
        for (let j = i + 1; j < dots.length; j++) {
          const a = dots[i], b = dots[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const dist = Math.hypot(dx, dy);
          if (dist < LINK) {
            ctx.strokeStyle = `rgba(${pr},${pg},${pb},${0.18 * (1 - dist / LINK)})`;
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          }
        }
        // links reaching toward the mouse (the key interaction)
        if (mouse.active) {
          const a = dots[i];
          const dm = Math.hypot(a.x - mouse.x, a.y - mouse.y);
          if (dm < MDIST) {
            ctx.strokeStyle = `rgba(${pr},${pg},${pb},${0.5 * (1 - dm / MDIST)})`;
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(mouse.x, mouse.y); ctx.stroke();
          }
        }
      }

      if (mouse.active) {
        ctx.beginPath();
        ctx.arc(mouse.x, mouse.y, 2.4, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${pr},${pg},${pb},0.95)`;
        ctx.fill();
      }

      if (!reduceMotion) requestAnimationFrame(frame);
    }

    frame(); // paint the first frame synchronously (frame() schedules the loop unless reduced-motion)
  }

  /* =======================================================================
     WIREFRAME GLOBE — build lat/long rings + orbiting icon nodes in code.
     ======================================================================= */
  function buildGlobe() {
    if (!CONFIG.showGlobe) { $("globeStage").style.display = "none"; return; }

    // Longitude rings: vertical ellipses rotated around Y
    const rings = $("globeRings");
    const LONG = 6;
    for (let i = 0; i < LONG; i++) {
      const el = document.createElement("div");
      el.className = "ring" + (i === 0 ? " ring--bright" : "");
      el.style.setProperty("--ry", (i * 180 / LONG) + "deg");
      el.style.setProperty("--rx", "80deg");
      rings.appendChild(el);
    }
    // Latitude rings: horizontal circles squashed on X, stacked on Y
    const LAT = [ -55, -28, 0, 28, 55 ];
    LAT.forEach((deg) => {
      const el = document.createElement("div");
      const scale = Math.cos(deg * Math.PI / 180);
      el.className = "ring" + (deg === 0 ? " ring--bright" : "");
      el.style.setProperty("--rx", "90deg");
      // squash toward the pole + lift along the sphere's axis
      el.style.width = (scale * 100) + "%";
      el.style.height = (scale * 100) + "%";
      el.style.left = ((1 - scale) * 50) + "%";
      el.style.top = ((1 - scale) * 50) + "%";
      el.style.transform =
        `translateZ(${Math.sin(deg * Math.PI / 180) * 17}rem) rotateX(90deg)`;
      rings.appendChild(el);
    });

    // Orbiting icon nodes — simple inline line glyphs, placed on a circle.
    const ICONS = {
      chart:   '<path d="M4 20V4h2v14h14v2H4Zm4-3 4-6 3 4 4-7" fill="none" stroke="currentColor" stroke-width="1.8"/>',
      monitor: '<rect x="3" y="4" width="18" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M9 20h6M12 16v4" stroke="currentColor" stroke-width="1.8"/>',
      shield:  '<path d="M12 3 5 6v5c0 4 3 7 7 9 4-2 7-5 7-9V6l-7-3Z" fill="none" stroke="currentColor" stroke-width="1.8"/>',
      gear:    '<circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" stroke="currentColor" stroke-width="1.6"/>',
      bulb:    '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3 11v2h6v-2a6 6 0 0 0-3-11Z" fill="none" stroke="currentColor" stroke-width="1.8"/>',
      search:  '<circle cx="11" cy="11" r="6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m16 16 4 4M8 12l2.5 2.5L15 9" stroke="currentColor" stroke-width="1.8" fill="none"/>',
      wifi:    '<path d="M4 9a13 13 0 0 1 16 0M7 12.5a8 8 0 0 1 10 0M10 16a3.5 3.5 0 0 1 4 0" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="19" r="1.3" fill="currentColor"/>',
      map:     '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Zm0 0v14M15 6v14" fill="none" stroke="currentColor" stroke-width="1.8"/>',
    };
    const order = ["chart", "monitor", "shield", "search", "bulb", "gear", "map", "wifi"];
    const orbit = $("orbit");
    const R = 44; // % radius from center
    order.forEach((key, i) => {
      const ang = (-90 + i * (360 / order.length)) * Math.PI / 180;
      const x = 50 + Math.cos(ang) * R;
      const y = 50 + Math.sin(ang) * R;
      const n = document.createElement("div");
      n.className = "node";
      n.style.left = `calc(${x}% - 1.55rem)`;
      n.style.top = `calc(${y}% - 1.55rem)`;
      n.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[key]}</svg>`;
      // counter-spin so icons stay upright while the globe rotates
      if (!reduceMotion) {
        n.style.animation = "spin360 34s linear infinite reverse";
      }
      orbit.appendChild(n);
    });
  }

  /* ---- Captcha (cosmetic canvas) ---- */
  function drawCaptcha() {
    const cv = $("captcha"); if (!cv) return;
    const ctx = cv.getContext("2d");
    const w = cv.width, h = cv.height;
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    captchaText = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#f4f7fb"; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 5; i++) {
      ctx.strokeStyle = `rgba(24,111,194,${0.15 + Math.random() * 0.25})`;
      ctx.beginPath(); ctx.moveTo(Math.random() * w, Math.random() * h); ctx.lineTo(Math.random() * w, Math.random() * h); ctx.stroke();
    }
    for (let i = 0; i < captchaText.length; i++) {
      ctx.font = `bold ${24 + Math.floor(Math.random() * 6)}px "Segoe UI", sans-serif`;
      ctx.fillStyle = `hsl(${205 + Math.random() * 25}, 60%, ${35 + Math.random() * 15}%)`;
      ctx.save();
      ctx.translate(14 + i * 26, h / 2 + 9);
      ctx.rotate((Math.random() - 0.5) * 0.5);
      ctx.fillText(captchaText[i], 0, 0);
      ctx.restore();
    }
  }
  function refreshCaptcha() {
    const btn = $("captchaRefresh");
    btn.classList.remove("spin"); void btn.offsetWidth; btn.classList.add("spin");
    drawCaptcha();
  }

  /* ---- Small field helpers ---- */
  function syncClear() { $("userClear").hidden = $("username").value.length === 0; }
  function capsHandler(e) {
    if (typeof e.getModifierState !== "function") return;
    $("capsHint").hidden = !e.getModifierState("CapsLock");
  }
  function togglePassword() {
    const inp = $("password");
    const show = inp.type === "password";
    inp.type = show ? "text" : "password";
    $("pwToggle").querySelector(".eye-open").hidden = show;
    $("pwToggle").querySelector(".eye-off").hidden = !show;
    $("pwToggle").setAttribute("aria-label", show ? "Hide password" : "Show password");
    inp.focus();
  }

  /* ---- Fake submit (no network) ---- */
  function onSubmit(e) {
    e.preventDefault();
    const t = CONFIG.i18n[lang];
    const status = $("status");
    status.classList.remove("is-info");

    if (!$("username").value.trim()) { status.textContent = t.needUser; $("username").focus(); return; }
    if (!$("password").value)        { status.textContent = t.needPass; $("password").focus(); return; }
    if (CONFIG.showVerifyCode) {
      const code = $("verifycode").value.trim();
      if (!code) { status.textContent = t.needCode; $("verifycode").focus(); return; }
      if (code.toUpperCase() !== captchaText) { status.textContent = t.badCode; refreshCaptcha(); $("verifycode").focus(); return; }
    }
    const btn = $("loginBtn");
    btn.classList.add("is-loading");
    $("lblLogin").innerHTML = `<span class="spinner"></span>${t.loggingIn}`;
    status.textContent = "";
    setTimeout(() => {
      btn.classList.remove("is-loading");
      $("lblLogin").textContent = t.login;
      status.classList.add("is-info");
      status.textContent = t.demo;
    }, 1400);
  }

  /* ---- Init ---- */
  function init() {
    applyTheme();
    applyLang(CONFIG.defaultLang);

    if (CONFIG.showVerifyCode) { $("verifyField").hidden = false; drawCaptcha(); }

    buildGlobe();
    initConstellation();

    $("username").addEventListener("input", syncClear);
    $("userClear").addEventListener("click", () => { $("username").value = ""; syncClear(); $("username").focus(); });
    $("password").addEventListener("keyup", capsHandler);
    $("password").addEventListener("keydown", capsHandler);
    $("pwToggle").addEventListener("click", togglePassword);
    $("captcha").addEventListener("click", refreshCaptcha);
    $("captchaRefresh").addEventListener("click", refreshCaptcha);
    $("loginForm").addEventListener("submit", onSubmit);
    $("langEn").addEventListener("click", () => applyLang("en"));
    $("langZh").addEventListener("click", () => applyLang("zh"));
    $("lblForgot").addEventListener("click", (e) => {
      e.preventDefault();
      const s = $("status"); s.classList.add("is-info"); s.textContent = CONFIG.i18n[lang].demo;
    });

    syncClear();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
