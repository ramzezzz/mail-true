# Dark Particle + Globe Login

A self-contained, front-end-only enterprise login screen: a dark navy page with
an interactive particle **constellation** (dots + links that reach toward your
mouse cursor), a rotating **CSS-3D wireframe globe** with orbiting icon nodes,
and a white login **card** with underline-style fields.

Everything visual is generated **in code** — there are no image assets and no
vendor branding. The logo is a generic inline SVG "molecule"; swap it for your
own. Colors, text, and behavior are driven by the `CONFIG` object in `app.js`.

> **Front-end only.** There is no backend. Submitting the form runs a fake
> "Signing in…" state and shows a demo message — nothing is sent anywhere.

## Run it
Open `index.html` in any modern browser. No build step, no server, no
network/CDN. (Uses a system font stack, so no font files are needed either.)

## Files
- `index.html` — markup / structure
- `styles.css` — all styling (commented by section)
- `app.js` — the `CONFIG` object + behavior (constellation, globe, i18n, submit)
- `README.md` — this file

_(The `assets/` folder is intentionally empty/removed — all visuals are code.)_

## Customize — `CONFIG` at the top of `app.js`

| What | Key |
| --- | --- |
| Product name | `brandName` |
| Optional tagline | `brandTagline` |
| Accent / brand color | `accent`, `accentHover`, `accentPress` |
| Particle count | `particleCount` |
| Particle color (RGB) | `particleColor` (e.g. `"150,190,245"`) |
| Link / mouse-link distances | `linkDistance`, `mouseDistance` |
| Show the 3D globe | `showGlobe` (`true`/`false`) |
| Show the captcha field | `showVerifyCode` (default `false`) |
| Default language | `defaultLang` (`"en"`/`"zh"`) |
| Footer lines (browser + copyright) | `footer.browser.{en,zh}`, `footer.copyright.{en,zh}` |
| All UI labels | `i18n.en`, `i18n.zh` |

**Swap the logo:** edit the inline `<svg id="brandLogo">` in `index.html`
(a few connected circles) — or drop in your own SVG/`<img>` there. It inherits
the accent color via `currentColor`.

**Change colors:** edit `CONFIG.accent*` (injected as CSS variables at runtime).
Other palette tokens (background navy, card, borders, footer) live in `:root`
at the top of `styles.css`.

**Language toggle** (EN | 中, top-right of the card) swaps every label and the
footer text live.

## Behavior & accessibility
- Globe slow-rotates; particles drift and draw lines toward the cursor.
- Entrance fade/slide for the card + globe; input focus + button hover/press.
- Respects `prefers-reduced-motion` (freezes the globe and particle animation;
  the constellation is still drawn as a static frame).
- Responsive: the globe hides and the card centers on narrow screens.
