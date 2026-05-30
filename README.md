# NanoShield

**English** · [日本語](./README.ja.md)

A Chrome extension that masks sensitive information **in the video the other party receives**, only while you are screen sharing.
Your own working screen stays untouched — only the shared stream is processed.

Built with TypeScript + [WXT](https://wxt.dev).

## How it works

It overrides `navigator.mediaDevices.getDisplayMedia`, processes the returned video frame by frame on a `<canvas>`,
applies the mask, and hands the processed `MediaStream` back to the app (Meet / Zoom, etc.).

```
getDisplayMedia()
  └─ source stream ──▶ <video>(hidden) ──▶ <canvas> draw + mask ──▶ canvas.captureStream()
                                                                      └─▶ returned to app (= what the viewer sees)
```

- The other party's video and your own self-preview inside the app are masked.
- The only thing not masked is "the real tab you are actually working on".

### World / process layout

| Where it runs | Role | Constraint |
| --- | --- | --- |
| `entrypoints/inject.content.ts` (MAIN world) | override `getDisplayMedia` + canvas processing + DOM/frame collection | no `chrome.*` |
| `entrypoints/bridge.content.ts` (ISOLATED world) | relay messages between inject ↔ extension + persist settings | cannot override `getDisplayMedia` |
| `entrypoints/background.ts` (service worker) | hotkey forwarding + Gemini Nano execution | no DOM |

- inject ↔ bridge: namespaced envelope over `window.postMessage`.
- bridge ↔ background/popup: `chrome.runtime` / `chrome.tabs` messages.
- All messages are typed with discriminated unions in `lib/messages.ts`.

> Note: WXT's `browser` is the native `chrome` itself (no polyfill). Native Chrome's `onMessage`
> does not support async responses via a returned Promise, so background uses `sendResponse + return true`.

### AI detection (Phase 2 / Gemini Nano)

On-device Prompt API (`self.LanguageModel`) detects sensitive elements in two stages and returns CSS selectors to mask.
The extension service worker is the only context that can use it without an origin trial, so Nano runs in the background.

```
popup "Detect now"
  └─ run-detection ─▶ inject: collect DOM snapshot + (optionally) downscaled-frame dataURL
        └─ detect-payload ─▶ bridge ─ runtime ─▶ background
              Stage 1: DOM text   ─▶ Nano(responseConstraint) ─▶ selectors
              Stage 2: frame image ─▶ Nano(multimodal)         ─▶ selectors
              └─ union ─▶ bridge ─▶ inject(set-auto-selectors / kept separate from manual ones)
```

- Structured output (`responseConstraint`) forces `{selectors: string[]}`, with `parseSelectorResponse` as a safety net.
- The image stage only runs when a downscaled-frame dataURL exists (otherwise reported as `skipped`).
- **No silent fallback**: Nano unavailable / model not downloaded / stage failure are all surfaced in the popup. Never swallowed as an empty array.
- **fail-closed**: on a detection error, existing auto masks are kept (never removed mid-share).

#### Auto re-detection

Pressing "Detect now" once arms that tab; from then on it re-detects automatically as the content changes.

- **Triggers (all debounced ~1s)**: SPA navigation (`pushState`/`replaceState`/`popstate`/`hashchange`),
  `pageshow`, becoming visible, large DOM changes (MutationObserver), user interaction (click/focus).
- Runs **only while sharing** (self-tab share, or a shared tab that the background signals as live) **and only while visible**.
  It never starts Nano during ordinary, non-shared browsing.
- Calls Nano **only when the DOM snapshot changed** since the last run (avoids redundant calls). Even under continuous
  changes, `maxWait` guarantees it fires at least once every few seconds (starvation guard). Results are accepted only
  when their id matches the latest detection (prevents out-of-order stale results).
- **Residual risk (fail-open window)**: the few seconds between sensitive content rendering and re-detection completing
  are unmasked. The gap is small when sensitive data appears after user action, but it can be visible on pages that
  render sensitive data inline in the initial HTML. For moments you must hide, use manual "Detect now" or `Ctrl+Shift+K` (full-frame).

### Cross-tab coordination (element masking when sharing another tab in Meet/Zoom)

The document that calls `getDisplayMedia` (meet.google.com) and the shared surface (another tab such as Gmail) are different,
and for privacy the browser does not tell the caller which tab was shared. So all tabs coordinate:

```
each armed tab inject: publishes its sensitive elements in normalized coords (0..1)
  └─ bridge ─ runtime ─▶ background (aggregates per-tab rects + armed)
capturer inject: subscribe ◀─ set-remote-rects (aggregated rects of all armed tabs) ─┘
  └─ the processing pipeline applies local DOM ∪ remote rects as "normalized × frame size"
```

| Scenario | Per-element mask | Emergency full-frame mask |
| --- | --- | --- |
| Self-tab share (`preferCurrentTab`) | **yes** (local DOM, zero lag) | yes |
| Sharing another tab in Meet, etc. | **yes** (cross-tab coordination) | yes |
| Window / whole screen | no (cannot map DOM → frame coords) | yes |

- **fail-closed matching**: since the browser won't say which tab is shown, we don't bet on a single source —
  we **send the rects of all armed tabs (except itself), and the capturer applies local ∪ remote**.
  Exact for a single sensitive tab. With **multiple sensitive tabs open at once it over-masks (a safe-side degradation)**.
- **The shared side must be armed**: rects are only published once you add a manual selector or run "Detect now" on that tab.
- Changes like scrolling are followed via events + a low-frequency tick, so there is a slight lag.
- When `displaySurface` is not a tab, the popup shows a warning (no silent degradation).

### Known privacy constraint (the nature of MAIN world)

To override `getDisplayMedia`, inject must live in the **MAIN world (= the page's own JS context)**.
Because of this, the `window.postMessage` traffic between inject ↔ bridge **can be observed/forged by that page's JS**:

- The `detect-payload` inject emits (a screenshot / DOM snapshot of its own page) only appears on **that page's own window**.
  The page already has full access to its own content, so this is not a new leak.
- The only newly-introduced flow is "the shared side's rect coordinates reach the capturer (meet)" (positions only, no content — low risk).
- A malicious page could send a fake `set-enabled:false` to disable masking, but there is no gain for an attacker (it's their own page).

Full isolation would require not using the MAIN world, but then overriding `getDisplayMedia` would not work. We accept this as a trade-off.

### Safe-side design

If pipeline construction fails, the unprocessed raw stream is **never returned — an exception is thrown instead**.
The share itself fails, but sensitive information is never leaked unmasked (fail-closed).

## Development

```sh
pnpm install        # install deps (postinstall runs wxt prepare to generate types)
pnpm dev            # generate .output/chrome-mv3 with auto-reload
pnpm compile        # type-check via tsc --noEmit
pnpm test           # vitest (unit tests for pure logic)
pnpm check          # prepare + tsc + test + build in one shot
pnpm build          # production build
pnpm zip            # distribution zip
```

Tested (DOM/Chrome-independent pure logic): coordinate mapping (`lib/masking`), image downscaling (`lib/image`),
DOM formatting (`lib/dom-snapshot`), Nano response parsing (`lib/nano-parse`),
detection orchestration error policy (`lib/nano-detect`), message type guards (`lib/messages`).

## Install (load the extension)

1. Run `pnpm build` (or `pnpm dev`)
2. Open `chrome://extensions/`
3. Turn on "Developer mode" (top right)
4. "Load unpacked" → select **`.output/chrome-mv3`**

## Test procedure (self-tab share)

1. Open any page (e.g. your own dashboard with a balance or ID)
2. Open the popup from the extension icon and add a CSS selector under "elements to mask" (e.g. `.balance`, `#email`)
3. In an app that starts screen sharing, choose **"Chrome tab"** and share **this tab**
4. Confirm the target element is blurred / blacked out on the other side (or in the share preview)
5. Verify the `Ctrl+Shift+M` hotkey toggles masking and `Ctrl+Shift+K` toggles full-frame mask

### Quick standalone check (no app needed, self-tab share)

Run the following in the DevTools Console of the target page and pick **this tab** in the picker; the processed (masked)
video that goes through `getDisplayMedia` will appear overlaid on the right half.

```js
const s = await navigator.mediaDevices.getDisplayMedia({
  video: true,
  preferCurrentTab: true, // prefer self-tab share
});
const v = Object.assign(document.createElement("video"), {
  srcObject: s, autoplay: true, style: "position:fixed;inset:0;z-index:99999;width:50vw",
});
document.body.append(v);
```

If you add a mask-target selector (e.g. `.balance`) in the popup beforehand,
the matching area of the overlaid processed video will be blurred / blacked out.

## Manual check for Gemini Nano

On-device Nano needs a supported Chrome, hardware requirements, and a model download, and cannot be verified by automated tests.
On a real device, verify:

1. Check model status at `chrome://on-device-internals` (or `chrome://components`)
2. In the extension's service worker console, run `await LanguageModel.availability({expectedInputs:[{type:'text'}]})`
   and check it returns `'available'` / `'downloadable'` etc.
3. Popup "Enable model" to download → "Detect now" → check the selector count appears in `detect-result`
4. Check the detected selectors get masked during a self-tab share

Even where Nano is unavailable, manual selectors, full-frame mask, and hotkeys still work as before (only AI detection is disabled).

## File layout

```
wxt.config.ts          manifest definition + WXT config
tsconfig.json          strict (adds noUncheckedIndexedAccess, etc.)
vitest.config.ts       test config (resolves the @/ alias)
types/
  prompt-api.d.ts      ambient types for LanguageModel (Prompt API)
lib/                   DOM/Chrome-independent pure logic (unit-tested)
  messages.ts          message contract (discriminated unions). The shared contract layer for all entrypoints
  masking.ts           coordinate mapping / clamping / normalization (cross-tab)
  image.ts             frame downscale size computation
  dom-snapshot.ts      DOM snapshot formatting
  nano-parse.ts        selector extraction from Nano responses (safety net)
  nano-detect.ts       two-stage Nano detection orchestration (pure part + SW execution part)
entrypoints/
  inject.content.ts    MAIN world: override getDisplayMedia + canvas processing + DOM/frame collection
  bridge.content.ts    ISOLATED world: message relay + settings persistence
  background.ts        hotkey relay + Nano execution (service worker)
  popup/
    index.html / main.ts / style.css
tests/                 vitest (pure logic)
public/
  icon-128.png
```

## Manual check in Meet/Zoom (cross-tab)

1. On the "shared side" tab (e.g. Gmail), add a sensitive-element selector in the popup (e.g. `span.bqe`) or arm it with "Detect now"
2. In a separate Meet/Zoom tab, "Share a tab" → pick that Gmail tab
3. Confirm the armed elements get masked on the other side (or in the share preview)
4. If matching is off, keep "tabs with sensitive rects" down to one (multiple simultaneous shares make matching unstable)

## Roadmap

- [x] Phase 1: screen-share detection + stream-processing mask + manual selectors + hotkeys + UI
- [x] Phase 2: automatic mask-target detection with Gemini Nano (two stages: DOM text → canvas frame image)
- [x] Cross-tab coordination (element masking when sharing another tab in Meet/Zoom)
- [ ] Phase 3: full browser agent (separate project)

### Known issues / future

- Cross-tab uses a "send the rects of all armed tabs" fail-closed approach. With multiple sensitive tabs open at once it over-masks.
- Auto re-detection leaves a fail-open window of a few seconds between "render → re-detection complete" (notably for inline sensitive HTML).
- The accuracy of the Stage-2 "visual region → CSS selector" estimation must be validated empirically.
