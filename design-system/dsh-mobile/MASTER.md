# DSH Mobile design system

## Direction

This is an internal design reference, not a promise that DSH Mobile replaces the host UI. Plugin-owned controls follow DSH's current theme; native connection screens follow Android light/dark mode and place readable cards over the bundled character artwork. Keep controls calm and functional. Avoid decorative gradients, glow, glass effects, particles, animated ambient backgrounds, or emoji icons in product controls; the existing brand illustration is separate from these controls.

## Color

The native colors below mirror the [light](../../apps/mobile/android/app/src/main/res/values/colors.xml) and [dark](../../apps/mobile/android/app/src/main/res/values-night/colors.xml) resources; use DSH semantic tokens instead for WebView controls.

| Native role | Light | Dark |
| --- | --- | --- |
| Background | `#F7F8FA` | `#0F172A` |
| Card surface | `#FFFFFF` | `#1E293B` |
| Primary text | `#111827` | `#F8FAFC` |
| Secondary text | `#667085` | `#CBD5E1` |
| Accent | `#2563EB` | `#60A5FA` |
| Text on primary button | `#FFFFFF` | `#0F172A` |
| Border | `#E4E7EC` | `#475569` |
| Error | `#B91C1C` | `#FCA5A5` |

Maintain at least 4.5:1 text contrast over cards and artwork scrims. Native screens follow Android's theme; the WebView follows DSH's theme. Plugin surfaces must not force a global theme.

## Typography

In WebView controls, inherit DSH's system font stack. Use at least 16 CSS pixels for mobile inputs to avoid focus zoom while preserving larger user font preferences. The existing repository hero asset includes its own brand title; do not overlay a duplicate title.

Keep per-Origin mobile font preferences separate from App-wide WebView zoom. Show advanced typography only when the theme consumes its public tokens; a terminal canvas needs its own supported font control. Native text uses scaled text units (`sp`), while native geometry uses `dp`; neither is a raw device pixel.

## Shape and depth

- Native card radius: 16–20dp according to the existing screen.
- Native button radius: 12dp for secondary actions and 16dp for primary actions; preserve existing component variants.
- Native touch target: at least 48dp. Web targets: at least 44 CSS pixels, with 48px for primary mobile actions where space permits.
- Use a subtle theme-aware border and restrained shadows.
- Never shift layout on hover or press.

## Motion

Use short 150–240ms state/navigation transitions. Respect `prefers-reduced-motion`; avoid decorative entrance or ambient animation. A loading indicator may run while an operation is pending, with a visible cancellation action for connection waits. Reveal a painted webpage without keeping the full-screen artwork above its progress; keep the smaller cancellation action until it becomes usable.

## Mobile layout

- Honor safe-area insets on every edge.
- Keep conversation content full-width on narrow screens.
- Prevent page-level horizontal overflow. Wide tables and code blocks may scroll inside their own containers.
- Keep primary actions reachable above the soft keyboard.
- Test 375px and 390px portrait, landscape, font scaling, and keyboard-open states.

## Brand artwork

- Default app artwork: `assets/brand/app-icon-master.png` shows the whale-themed character holding a phone. Keep this as the default identity and README icon; do not add text or watermarks. The app also offers six existing DeepSeek whale-mark color variants through native Launcher aliases. Selecting one changes only the launcher artwork, not the package, signer or paired data; it does not make this community app an official DeepSeek client.
- Repository hero: use `assets/brand/repository-hero.png`; the existing image includes the DSH Mobile title at left and a character with a desktop scene at right. Keep README copy outside the image rather than duplicating its built-in title.

## Delivery checklist

- [ ] Native light/dark colors or DSH semantic tokens, with readable artwork scrims.
- [ ] No emoji icons, gradients, glow, particles, or glass effects.
- [ ] Visible keyboard focus.
- [ ] Native targets at least 48dp; Web targets at least 44 CSS pixels.
- [ ] Safe-area and soft-keyboard handling.
- [ ] Reduced motion supported.
- [ ] No content hidden behind fixed controls.
- [ ] No page-level horizontal overflow at 375px; wide content scrolls only inside its container.
