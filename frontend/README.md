# NeuroGraph — Frontend

A **single-fold, scroll-free** React UI for the NeuroGraph personal AI assistant — in the style of a
clean chat app. **Fully isolated**: this app makes *no network calls* and has **no imports from the
backend** (`../src`), so it can run entirely standalone.

## Stack

| Layer | Choice |
|---|---|
| Runtime | React 18 + TypeScript |
| Build | Vite 5 (dev server w/ HMR, production bundler) |
| Styling | vanilla CSS w/ custom-property theming (no framework) |
| Font | Inter (via Google Fonts) |

## Run it

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173
```

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Vite dev server with hot reload |
| `npm run build` | Type-check (`tsc --noEmit`) + production `vite build` → `dist/` |
| `npm run typecheck` | TypeScript check only |
| `npm run preview` | Serve the production build locally |

## Layout (single fold — nothing scrolls)

```
┌────────────────────────────────────────────┐  ← Header (sticky top)
│ NeuroGraph  ◦  Privacy  Terms  Privacy …  ☀/🌙 │
├────────────────────────────────────────────┤
│                                            │
│   ☀️ Good morning … I remember …          │  ← Chat list (scrolls internally)
│                                          ○ │
│                                          ○ You: Actually, I like coffee now.
│   ☕ Updated — I'll remember …            │
│                                            │
│  ┌────────────────────────────────────┐  │  ← Composer (pinned bottom)
│  │ Message NeuroGraph…                │ ⭢ │
│  └────────────────────────────────────┘  │
└────────────────────────────────────────────┘
```

- The page is a fixed-height app: header at top, a vertically-scrollable message list in the
  middle, and an always-visible composer at the bottom. The document itself **never scrolls**.
- Light/dark mode is persisted in `localStorage` and defaults to your OS preference
  (`prefers-color-scheme`).

## Privacy & consent (all popups)

- **Cookie banner** — a small bottom-right toast that appears on first visit. Accept / Reject /
  Preferences, or dismiss.
- **Privacy Choices** — the per-category preferences dialog (Strictly Necessary always-on,
  Functional, Analytics, Marketing). The Save button is enabled only when something changed.
- **Privacy Policy / Terms of Service** — opened as modal popups from the header (or the cookie
  toast), not as separate scrollable pages. Content is first-party only; no ad trackers.
- All choices are stored in `localStorage`.

## Connecting to the backend (later)

The UI is isolated by design. `vite.config.ts` already contains a commented `server.proxy` example
(`"/api" → "http://localhost:3000"`). When the Personal-Agent backend exposes an HTTP API, uncomment
it; nothing else in the UI needs to change.

## Notes

- `npm install` prints a non-fatal `allow-scripts` notice for `esbuild`'s postinstall. The install,
  typecheck and production build all succeed regardless. If a dev-server binary issue ever surfaces
  on Windows, run `npm approve-scripts` inside `frontend/`.
- No tests are included, per the project's frontend constraints.
