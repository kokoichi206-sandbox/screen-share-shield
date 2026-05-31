# Screen Share Shield

**English** · [日本語](./README.ja.md)

Screen Share Shield masks sensitive information **only in the video other people receive** while you screen share.
Your own screen stays exactly as it is.

AI detection runs **on-device** (Gemini Nano) — nothing is sent to a server.

## Demo

![Masked in the share, readable on your own screen](docs/hero.png)

Sharing a GitHub sign-in: in the shared video (left) the username and password are masked,
while your own tab (right) stays readable.

<img src="docs/popup.png" alt="Popup with AI-detected elements" width="320">

The popup — on-device AI detected the login fields (`#login_field`, `#password`).

## What it does

When you share a tab, it processes the outgoing video frame by frame and blurs (or blacks out) the sensitive areas.
The other party — and your own self-preview inside the meeting app — see the masked version, while the real tab you
are working in is untouched. You can choose what to hide manually, or let on-device AI find it.

## Features

- Masks only the shared video; your own screen is unaffected.
- On-device AI detection (Gemini Nano) finds sensitive fields — card numbers, emails, balances, IDs — and masks them.
  It re-detects automatically as the page changes (navigation, new fields, etc.).
- Manual masking: hide any element by CSS selector.
- Cross-tab: works even when you share a different tab in Meet/Zoom.
- Emergency full-frame mask: one hotkey blurs the entire shared frame instantly.
- Hotkeys: toggle mask (`Ctrl+Shift+M`), full-frame mask (`Ctrl+Shift+K`).
- Blur or black-out, with adjustable blur strength.

## Requirements

- A recent Chrome.
- For AI detection: a Chrome/device where Gemini Nano (the Prompt API) is available.
  Manual masking, cross-tab masking, and the full-frame mask work without it.

## Install

Loaded as an unpacked extension:

1. `pnpm install && pnpm build`
2. Open `chrome://extensions/` and turn on Developer mode
3. "Load unpacked" → select `.output/chrome-mv3`

## Usage

1. Open the page you want to protect and start sharing **a Chrome tab** in your meeting app.
2. Click the Screen Share Shield icon and choose what to hide:
   - Manually — enter a CSS selector (e.g. `.balance`, `#email`) and Add.
   - Automatically — click "Detect now"; on-device AI lists the sensitive elements it found and masks them.
3. The shared video now hides those areas, while your own view stays readable.
4. Need to hide everything at once? Press `Ctrl+Shift+K`.

When sharing one tab from another (e.g. presenting a tab in Meet), run "Detect now" on the tab that holds the sensitive
content — the masks follow it into the share.

## Limitations

- Per-element masking applies to **tab shares**. For window or whole-screen shares, only the emergency full-frame mask works.
- AI detection requires Gemini Nano to be available in your Chrome.
- With multiple sensitive tabs open at once, cross-tab masking errs on the safe side (it may over-mask).
- Right after a page change there is a brief window (a few seconds) before AI re-detection finishes; use manual
  "Detect now" or the full-frame mask for moments you must hide.

## For developers

Architecture, message protocol, build/test commands, and design trade-offs are in **[CLAUDE.md](./CLAUDE.md)**.

## License

MIT — see [LICENSE](./LICENSE).
