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
  brandName: 'Network Controller', // product name shown next to the logo
  brandTagline: '', // optional small line under brand (blank = hidden)

  /* ---- Theme ---- */
  accent: '#186FC2', // primary blue: button, links, focus, globe accents
  accentHover: '#1A7FD8',
  accentPress: '#135A9E',

  /* ---- Background: constellation WEB + twinkling STARS (both layers) ---- */
  particleCount: 72, // web nodes — the network that links up + reaches toward the cursor
  webColor: '150,190,245', // web dot/line RGB
  linkDistance: 132, // px: link two web nodes closer than this
  mouseDistance: 185, // px: link a node to the cursor within this
  starCount: 190, // twinkling stars (extra layer behind the web)
  starColor: '208,228,255', // star RGB (varying alpha => twinkle)

  /* ---- Globe ---- */
  showGlobe: true, // left CSS-3D wireframe globe
  globeRings: 8, // wireframe rings PER axis (X & Y) — higher = denser sphere
  lightBalls: 6, // glowing balls that run along the globe rings

  /* ---- Feature switches ---- */
  showVerifyCode: false, // captcha field (default off for the dark look)
  defaultLang: 'en', // "en" | "zh"

  /* ---- Footer (two lines) ---- */
  footer: {
    browser: {
      en: 'Use Google Chrome 100+, Firefox 91.8 ESR / 99+, or Microsoft Edge 100+. Recommended resolution 1920 x 1080, minimum 1366 x 768.',
      zh: '建议使用 Google Chrome 100+、Firefox 91.8 ESR / 99+ 或 Microsoft Edge 100+。推荐分辨率 1920 x 1080，最低 1366 x 768。',
    },
    copyright: {
      en: 'Copyright © 2015-2026 Network Controller. All rights reserved.',
      zh: '版权所有 © 2015-2026 Network Controller。保留一切权利。',
    },
  },

  /* ---- Localized UI text ---- */
  i18n: {
    en: {
      username: 'Username',
      usernamePlaceholder: 'Username',
      password: 'Password',
      passwordPlaceholder: 'Password',
      verifycode: 'Verify Code',
      verifycodePlaceholder: 'Verify code',
      remember: 'Remember login username',
      forgot: 'Forgot Password',
      login: 'Log In',
      loggingIn: 'Signing in…',
      capsOn: 'Caps Lock is on',
      needUser: 'Please enter your username.',
      needPass: 'Please enter your password.',
      needCode: 'Please enter the verify code.',
      badCode: 'Verify code is incorrect.',
      demo: 'Demo only — this is a front-end replica, no server is contacted.',
    },
    zh: {
      username: '用户名',
      usernamePlaceholder: '用户名',
      password: '密码',
      passwordPlaceholder: '密码',
      verifycode: '验证码',
      verifycodePlaceholder: '验证码',
      remember: '记住登录用户名',
      forgot: '忘记密码',
      login: '登 录',
      loggingIn: '正在登录…',
      capsOn: '大写锁定已开启',
      needUser: '请输入用户名。',
      needPass: '请输入密码。',
      needCode: '请输入验证码。',
      badCode: '验证码不正确。',
      demo: '仅为演示 — 这是纯前端复刻页面，不会连接任何服务器。',
    },
  },
};

/* ========================================================================= */
/*  Implementation — normally no need to edit below this line.               */
/* ========================================================================= */

(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let lang = CONFIG.defaultLang;
  let captchaText = '';

  /* ---- Theme variables ---- */
  function applyTheme() {
    const r = document.documentElement.style;
    r.setProperty('--accent', CONFIG.accent);
    r.setProperty('--accent-hover', CONFIG.accentHover);
    r.setProperty('--accent-press', CONFIG.accentPress);
  }

  /* ---- Localized text ---- */
  function applyLang(next) {
    lang = next;
    const t = CONFIG.i18n[lang];
    document.documentElement.lang = lang;

    $('brandName').textContent = CONFIG.brandName;
    $('lblUser').textContent = t.username;
    $('lblPass').textContent = t.password;
    $('lblCode').textContent = t.verifycode;
    $('lblRemember').textContent = t.remember;
    $('lblForgot').textContent = t.forgot;
    $('lblLogin').textContent = t.login;
    $('capsHint').title = t.capsOn;

    $('username').placeholder = t.usernamePlaceholder;
    $('password').placeholder = t.passwordPlaceholder;
    $('verifycode').placeholder = t.verifycodePlaceholder;

    $('footerBrowser').textContent = CONFIG.footer.browser[lang];
    $('footerCopyright').textContent = CONFIG.footer.copyright[lang];

    $('langEn').classList.toggle('is-active', lang === 'en');
    $('langZh').classList.toggle('is-active', lang === 'zh');
  }

  /* =======================================================================
     BACKGROUND (canvas) — three layers, all generated in code:
       1) twinkling STARS (many small dots slowly fading in/out at varying alpha)
       2) constellation WEB (drifting nodes linked to near nodes + to the cursor)
       3) a subtle wave-MESH in the bottom-right corner
     ======================================================================= */
  function initBackground() {
    const canvas = $('fx');
    const ctx = canvas.getContext('2d');
    let W = 0,
      H = 0,
      dpr = Math.min(window.devicePixelRatio || 1, 2);
    const stars = [],
      dots = [];
    const [sr, sg, sb] = CONFIG.starColor.split(',').map(Number);
    const [wr, wg, wb] = CONFIG.webColor.split(',').map(Number);
    const LINK = CONFIG.linkDistance,
      MDIST = CONFIG.mouseDistance;
    const mouse = { x: -9999, y: -9999, active: false };

    function resize() {
      W = canvas.clientWidth || window.innerWidth;
      H = canvas.clientHeight || window.innerHeight;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function seed() {
      stars.length = 0;
      for (let i = 0; i < CONFIG.starCount; i++) {
        stars.push({
          x: Math.random() * W,
          y: Math.random() * H,
          r: Math.random() * 1.7 + 0.55,
          base: Math.random() * 0.45 + 0.55, // base brightness (brighter floor)
          tw: Math.random() * 0.9 + 0.2, // twinkle speed
          ph: Math.random() * Math.PI * 2, // phase (out of sync)
          dx: (Math.random() - 0.5) * 0.04,
          dy: (Math.random() - 0.5) * 0.04,
        });
      }
      dots.length = 0;
      for (let i = 0; i < CONFIG.particleCount; i++) {
        dots.push({
          x: Math.random() * W,
          y: Math.random() * H,
          vx: (Math.random() - 0.5) * 0.28,
          vy: (Math.random() - 0.5) * 0.28,
          r: Math.random() * 1.5 + 0.7,
        });
      }
    }

    window.addEventListener('pointermove', (e) => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
      mouse.active = true;
    });
    window.addEventListener('pointerleave', () => {
      mouse.active = false;
      mouse.x = mouse.y = -9999;
    });
    window.addEventListener('resize', () => {
      resize();
      seed();
      if (reduceMotion) frame();
    });

    resize();
    seed();

    function drawMesh(t) {
      // faint dotted sine "ribbons" sweeping into the bottom-right corner
      const x0 = W * 0.6;
      for (let row = 0; row < 5; row++) {
        const alpha = 0.11 - row * 0.014;
        if (alpha <= 0) break;
        ctx.fillStyle = `rgba(120,170,240,${alpha})`;
        const baseY = H * 0.66 + row * 20;
        for (let x = x0; x < W; x += 7) {
          const yy = baseY + Math.sin(x * 0.012 + t * 0.4 + row * 0.7) * 11 + (x - x0) * 0.07;
          if (yy > 0 && yy < H) {
            ctx.beginPath();
            ctx.arc(x, yy, 0.9, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      // a few faint triangulated lines in the very corner
      const p = [
        [0.78, 0.6],
        [0.9, 0.72],
        [0.7, 0.82],
        [0.96, 0.87],
        [0.83, 0.96],
        [0.66, 0.7],
      ].map((q) => [q[0] * W, q[1] * H]);
      ctx.strokeStyle = 'rgba(130,175,240,0.10)';
      ctx.lineWidth = 1;
      for (let i = 0; i < p.length; i++)
        for (let j = i + 1; j < p.length; j++)
          if (Math.hypot(p[i][0] - p[j][0], p[i][1] - p[j][1]) < W * 0.23) {
            ctx.beginPath();
            ctx.moveTo(p[i][0], p[i][1]);
            ctx.lineTo(p[j][0], p[j][1]);
            ctx.stroke();
          }
    }

    let t = 0;
    function frame() {
      t += 0.016;
      ctx.clearRect(0, 0, W, H);

      // 1) twinkling stars (behind)
      for (const s of stars) {
        s.x += s.dx;
        s.y += s.dy;
        if (s.x < 0) s.x += W;
        else if (s.x > W) s.x -= W;
        if (s.y < 0) s.y += H;
        else if (s.y > H) s.y -= H;
        const a = Math.max(0.12, s.base * (0.5 + 0.5 * Math.sin(t * s.tw + s.ph)));
        // soft halo for the brighter/larger stars so the field reads clearly
        if (s.r > 1.3) {
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r * 2.6, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${sr},${sg},${sb},${a * 0.16})`;
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${sr},${sg},${sb},${a})`;
        ctx.fill();
      }

      // 3) corner wave-mesh (drawn under the web)
      drawMesh(t);

      // 2) constellation web — nodes + links + links to the cursor
      for (const d of dots) {
        d.x += d.vx;
        d.y += d.vy;
        if (d.x < 0 || d.x > W) d.vx *= -1;
        if (d.y < 0 || d.y > H) d.vy *= -1;
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${wr},${wg},${wb},0.8)`;
        ctx.fill();
      }
      for (let i = 0; i < dots.length; i++) {
        for (let j = i + 1; j < dots.length; j++) {
          const a = dots[i],
            b = dots[j];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          if (dist < LINK) {
            ctx.strokeStyle = `rgba(${wr},${wg},${wb},${0.18 * (1 - dist / LINK)})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
        if (mouse.active) {
          const a = dots[i];
          const dm = Math.hypot(a.x - mouse.x, a.y - mouse.y);
          if (dm < MDIST) {
            ctx.strokeStyle = `rgba(${wr},${wg},${wb},${0.5 * (1 - dm / MDIST)})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(mouse.x, mouse.y);
            ctx.stroke();
          }
        }
      }
      if (mouse.active) {
        ctx.beginPath();
        ctx.arc(mouse.x, mouse.y, 2.4, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${wr},${wg},${wb},0.95)`;
        ctx.fill();
      }

      if (!reduceMotion) requestAnimationFrame(frame);
    }

    frame();
  }

  /* =======================================================================
     WIREFRAME GLOBE — build lat/long rings + orbiting icon nodes in code.
     ======================================================================= */
  function buildGlobe() {
    if (!CONFIG.showGlobe) {
      $('globeStage').style.display = 'none';
      return;
    }

    // Dense wireframe sphere: N great-circle rings rotated around X, and N around
    // Y, so the two families cross to suggest a globe of lat/long lines.
    const rings = $('globeRings');
    const N = Math.max(3, CONFIG.globeRings || 8);
    for (let i = 0; i < N; i++) {
      const rx = document.createElement('div');
      rx.className = 'ring' + (i === 0 ? ' ring--bright' : '');
      rx.style.setProperty('--rx', ((i * 180) / N).toFixed(1) + 'deg');
      rings.appendChild(rx);

      const ry = document.createElement('div');
      ry.className = 'ring' + (i === 0 ? ' ring--bright' : '');
      ry.style.setProperty('--ry', ((i * 180) / N).toFixed(1) + 'deg');
      rings.appendChild(ry);
    }

    // Orbiting icon nodes — simple inline line glyphs, placed on a circle.
    const ICONS = {
      chart:
        '<path d="M4 20V4h2v14h14v2H4Zm4-3 4-6 3 4 4-7" fill="none" stroke="currentColor" stroke-width="1.8"/>',
      monitor:
        '<rect x="3" y="4" width="18" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M9 20h6M12 16v4" stroke="currentColor" stroke-width="1.8"/>',
      shield:
        '<path d="M12 3 5 6v5c0 4 3 7 7 9 4-2 7-5 7-9V6l-7-3Z" fill="none" stroke="currentColor" stroke-width="1.8"/>',
      gear: '<circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" stroke="currentColor" stroke-width="1.6"/>',
      bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3 11v2h6v-2a6 6 0 0 0-3-11Z" fill="none" stroke="currentColor" stroke-width="1.8"/>',
      search:
        '<circle cx="11" cy="11" r="6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m16 16 4 4M8 12l2.5 2.5L15 9" stroke="currentColor" stroke-width="1.8" fill="none"/>',
      wifi: '<path d="M4 9a13 13 0 0 1 16 0M7 12.5a8 8 0 0 1 10 0M10 16a3.5 3.5 0 0 1 4 0" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="19" r="1.3" fill="currentColor"/>',
      map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Zm0 0v14M15 6v14" fill="none" stroke="currentColor" stroke-width="1.8"/>',
    };
    const order = ['chart', 'monitor', 'shield', 'search', 'bulb', 'gear', 'map', 'wifi'];
    const orbit = $('orbit');
    const R = 45; // % radius from center
    order.forEach((key, i) => {
      const ang = ((-90 + i * (360 / order.length)) * Math.PI) / 180;
      const x = 50 + Math.cos(ang) * R;
      const y = 50 + Math.sin(ang) * R;
      // A positioned WRAP scales smoothly on hover (CSS transition); the inner
      // .node circle gently pulses and does one clockwise spin while hovered.
      const wrap = document.createElement('div');
      wrap.className = 'node-wrap';
      wrap.style.left = `calc(${x}% - 1.55rem)`;
      wrap.style.top = `calc(${y}% - 1.55rem)`;

      const n = document.createElement('div');
      n.className = 'node';
      // stationary icons that gently pulse, out of sync (staggered delay)
      n.style.setProperty('--pd', (i * 0.34).toFixed(2) + 's');
      n.style.setProperty('--pdur', (2.4 + (i % 3) * 0.4).toFixed(2) + 's');
      n.innerHTML = `<span class="node__i"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[key]}</svg></span>`;
      wrap.appendChild(n);
      orbit.appendChild(wrap);
    });

    buildBalls();
  }

  /* Glowing balls that run ALONG the globe's wireframe rings. Each ball sits on
     a plane matching one ring (same --rx / --ry) and orbits within that plane;
     because it lives inside the spinning globe, it rides the ring in 3D. */
  function buildBalls() {
    const wrap = $('globeBalls');
    if (!wrap) return;
    const N = Math.max(0, CONFIG.lightBalls || 0);
    const NR = Math.max(3, CONFIG.globeRings || 8);
    const RAD = '17.2rem'; // ball orbit radius ≈ globe ring radius
    for (let i = 0; i < N; i++) {
      const plane = document.createElement('div');
      plane.className = 'ball-plane';
      const ang = (((i * 2 + 1) % NR) * 180) / NR; // pick a ring angle
      plane.style.setProperty(i % 2 === 0 ? '--rx' : '--ry', ang.toFixed(1) + 'deg');

      const orb = document.createElement('div');
      orb.className = 'ball-orb';
      orb.style.setProperty('--dur', (9 + i * 2.1).toFixed(1) + 's');
      orb.style.setProperty('--delay', (-i * 2.7).toFixed(1) + 's');
      if (reduceMotion) orb.style.animation = 'none';

      const ball = document.createElement('div');
      ball.className = 'ball';
      ball.style.setProperty('--r', RAD);

      orb.appendChild(ball);
      plane.appendChild(orb);
      wrap.appendChild(plane);
    }
  }

  /* ---- Captcha (cosmetic canvas) ---- */
  function drawCaptcha() {
    const cv = $('captcha');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const w = cv.width,
      h = cv.height;
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    captchaText = Array.from(
      { length: 4 },
      () => chars[Math.floor(Math.random() * chars.length)],
    ).join('');
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#f4f7fb';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 5; i++) {
      ctx.strokeStyle = `rgba(24,111,194,${0.15 + Math.random() * 0.25})`;
      ctx.beginPath();
      ctx.moveTo(Math.random() * w, Math.random() * h);
      ctx.lineTo(Math.random() * w, Math.random() * h);
      ctx.stroke();
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
    const btn = $('captchaRefresh');
    btn.classList.remove('spin');
    void btn.offsetWidth;
    btn.classList.add('spin');
    drawCaptcha();
  }

  /* ---- Small field helpers ---- */
  function syncClear() {
    $('userClear').hidden = $('username').value.length === 0;
  }
  function capsHandler(e) {
    if (typeof e.getModifierState !== 'function') return;
    $('capsHint').hidden = !e.getModifierState('CapsLock');
  }
  function togglePassword() {
    const inp = $('password');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    $('pwToggle').querySelector('.eye-open').hidden = show;
    $('pwToggle').querySelector('.eye-off').hidden = !show;
    $('pwToggle').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    inp.focus();
  }

  /* ---- Fake submit (no network) ---- */
  function onSubmit(e) {
    e.preventDefault();
    const t = CONFIG.i18n[lang];
    const status = $('status');
    status.classList.remove('is-info');

    if (!$('username').value.trim()) {
      status.textContent = t.needUser;
      $('username').focus();
      return;
    }
    if (!$('password').value) {
      status.textContent = t.needPass;
      $('password').focus();
      return;
    }
    if (CONFIG.showVerifyCode) {
      const code = $('verifycode').value.trim();
      if (!code) {
        status.textContent = t.needCode;
        $('verifycode').focus();
        return;
      }
      if (code.toUpperCase() !== captchaText) {
        status.textContent = t.badCode;
        refreshCaptcha();
        $('verifycode').focus();
        return;
      }
    }
    const btn = $('loginBtn');
    btn.classList.add('is-loading');
    $('lblLogin').innerHTML = `<span class="spinner"></span>${t.loggingIn}`;
    status.textContent = '';
    setTimeout(() => {
      btn.classList.remove('is-loading');
      $('lblLogin').textContent = t.login;
      status.classList.add('is-info');
      status.textContent = t.demo;
    }, 1400);
  }

  /* ---- Init ---- */
  function init() {
    applyTheme();
    applyLang(CONFIG.defaultLang);

    if (CONFIG.showVerifyCode) {
      $('verifyField').hidden = false;
      drawCaptcha();
    }

    buildGlobe();
    initBackground();

    $('username').addEventListener('input', syncClear);
    $('userClear').addEventListener('click', () => {
      $('username').value = '';
      syncClear();
      $('username').focus();
    });
    $('password').addEventListener('keyup', capsHandler);
    $('password').addEventListener('keydown', capsHandler);
    $('pwToggle').addEventListener('click', togglePassword);
    $('captcha').addEventListener('click', refreshCaptcha);
    $('captchaRefresh').addEventListener('click', refreshCaptcha);
    $('loginForm').addEventListener('submit', onSubmit);
    $('langEn').addEventListener('click', () => applyLang('en'));
    $('langZh').addEventListener('click', () => applyLang('zh'));
    $('lblForgot').addEventListener('click', (e) => {
      e.preventDefault();
      const s = $('status');
      s.classList.add('is-info');
      s.textContent = CONFIG.i18n[lang].demo;
    });

    syncClear();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
