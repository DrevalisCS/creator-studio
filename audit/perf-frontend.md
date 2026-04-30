# Frontend Audit — Perf, UX & A11y

Scope: `frontend/` (React 18 + TS + Tailwind + Vite 6, Radix primitives, lucide-react). Read-only audit.

Build artefact reference: `frontend/dist/assets/` (committed snapshot, dated 22 Apr).

---

## Bundle inventory (chunks > 100 KB and notable)

| Chunk | Size (raw) | Likely contents |
|---|---|---|
| `index-CM1ILlBJ.js` | **316 KB** | Main app shell entry (React, react-router, Radix primitives, Layout/Sidebar/Header/ActivityMonitor, theme, api monolith, types, websocket lib) |
| `index-efD0G6wL.js` | **139 KB** | Lazy chunk (likely `Settings/_monolith.tsx`, 3504 LOC) |
| `index-Cy_uTDkb.js` | **131 KB** | Lazy chunk (likely `EpisodeDetail/_monolith.tsx`, 2997 LOC) |
| `index-D3etteK6.js` | **99 KB** | Lazy chunk (likely `YouTube/_monolith.tsx`, 2175 LOC) |
| `index-Vd7Nk-px.css` | 65 KB | Tailwind CSS bundle |
| `index-kKVPnomM.js` | 49 KB | Lazy chunk (Audiobooks or AudiobookDetail monolith) |
| `index-BBx7OL9B.js` | 39 KB | Likely `EditorLayout` / shared editor chunk |
| `index-aQ8Ru4NO.js` | 34 KB | Lazy chunk |
| `EpisodeEditor` | 28 KB | OK |
| `index-wd1bYtdj.js` | 24 KB | Likely `SeriesDetail/_monolith.tsx` |
| Per-icon chunks (`archive`, `globe`, `eye`, etc.) | 0.3-0.7 KB each | lucide-react icons split per-file (good) |

Single deps over 100 KB: none in isolation that I can attribute confidently from `package.json` (only React/ReactDOM, react-router, four `@radix-ui/*` packages, lucide-react). The 316 KB main entry is dominated by React + ReactDOM (~130 KB min) + react-router-dom (~35 KB) + the Radix popover/tabs/toast/tooltip primitives (~50 KB combined) + the `lib/api/_monolith.ts` (1625 LOC) which is bundled into the main entry because every page imports from `@/lib/api`.

---

## Findings

### F-PF-01: Main entry chunk is 316 KB — `lib/api/_monolith.ts` and `types/_split/_monolith.ts` shipped in initial bundle
- **Severity:** HIGH
- **Location:** `frontend/src/lib/api/_monolith.ts:1-1625`, `frontend/src/types/_split/_monolith.ts`, every page imports `@/lib/api`
- **Evidence:** 1625-LOC API client containing every endpoint wrapper (episodes, series, jobs, audiobooks, youtube, social, runpod, comfyui, settings, license, …) is referenced from `App.tsx` chain (Dashboard, Layout, ActivityMonitor) and therefore lands in `index-CM1ILlBJ.js` (316 KB).
- **Impact:** Initial paint blocks on a ~316 KB JS download (gzip ~95 KB), even on `/login`. Mobile/cold-cache TTI suffers; the entire YouTube/RunPod/Audiobook surface is parsed before the user sees the dashboard.
- **Effort:** medium
- **Suggested fix:** Split `lib/api` into per-domain modules (`api/episodes.ts`, `api/youtube.ts`, …) and import only what each page needs. The barrel export pattern via `_monolith` is convenient but defeats route-level splitting.

### F-PF-02: Settings page chunk is 139 KB
- **Severity:** HIGH
- **Location:** `frontend/src/pages/Settings/_monolith.tsx` (3504 LOC, single file)
- **Evidence:** Settings module compiles to a 139 KB chunk — second-largest after the entry. CLAUDE.md says service/route monoliths should be split into packages with `__init__.py` re-exports; Settings has a `sections/` sub-folder but the monolith still owns most logic.
- **Impact:** First navigation to Settings takes ~500 ms+ on slow 3G after parse; users frequently flip to Settings during onboarding so it isn't a rare path.
- **Effort:** medium
- **Suggested fix:** Move each Settings tab (LLM, ComfyUI, voices, YouTube, Appearance, License, Backup, Updates, Team) to its own lazily-imported sub-route or `React.lazy` panel. The folder already has section files — wire them to `lazy()` and stop fanning the monolith back into one chunk.

### F-PF-03: ActivityMonitor is mounted on every page and re-renders every 3s; no `useMemo`/`useCallback`/`memo`
- **Severity:** HIGH
- **Location:** `frontend/src/components/ActivityMonitor.tsx:142-192, 109-674`; mounted in `frontend/src/components/layout/Layout.tsx:120`
- **Evidence:** `setInterval(() => void poll(), 3000)` at line 187 calls `setTasks(...)` every poll, mapping over `tasksRes.tasks` and reading `latestByEpisode` (which itself updates on every WS message). The component has zero memoization — `STEP_COLORS`, `STEP_TEXT_COLORS`, `TASK_ICONS`, `PRIORITY_OPTIONS` are module-level (good), but `tasks.map`, `tasks.slice(0, 3)`, the string-array `className` joins, and the inline arrow handlers all run every render. The big effect's dependency array is `[latestByEpisode]` (line 192), so every WS message triggers a poll-reset and a full re-render of the dock plus its children.
- **Impact:** While generation is active the dock and the entire layout subtree re-render multiple times per second — measurable jank during long-form generation when 4+ episodes are streaming progress. CPU stays warm even when the panel is collapsed.
- **Effort:** medium
- **Suggested fix:** Split `ActivityMonitor` into a `useActivityState()` hook and a memoized presenter. Memoize the mapped `tasks` derivation, drop `latestByEpisode` from the polling effect's deps (read it via ref inside the poll callback), and wrap the per-task row in `React.memo`. Also: don't re-poll on every WS message — let WS update task progress in place.

### F-PF-04: Dashboard fires five HTTP calls in parallel and computes derived data on every render
- **Severity:** MEDIUM
- **Location:** `frontend/src/pages/Dashboard.tsx:129-153, 186-194, 352-405`
- **Evidence:**
```ts
const [recentRes, seriesRes, jobsRes, allEpsRes, activityRes] = await Promise.all([
  episodesApi.recent(8), seriesApi.list(), jobsApi.active(),
  episodesApi.list(),  // <-- pulls EVERY episode just to count statuses
  episodesApi.recent(10),
]);
```
Plus `seriesById = Object.fromEntries(...)` (line 194) and the `activeJobs.reduce(...)` grouping (lines 352-361) re-run on every render — including the 10-second `setInterval` poll for active jobs (line 164).
- **Impact:** `episodesApi.list()` on a project with hundreds of episodes returns the full payload every dashboard mount. The derived `seriesById`/grouping objects also recreate every render, which busts memoization on `EpisodeCard`/`JobProgressBar`.
- **Effort:** small
- **Suggested fix:** Use a dedicated `episodesApi.stats()` (counts only) instead of pulling the full list; wrap `seriesById` and the activeJobs grouping in `useMemo` with explicit deps; move active-jobs polling out of Dashboard (ActivityMonitor already polls — share state via context).

### F-PF-05: EpisodesList does heavy filter+sort inline on every render
- **Severity:** MEDIUM
- **Location:** `frontend/src/pages/EpisodesList.tsx:221-261`
- **Evidence:** `visibleEpisodes` is computed via an IIFE on each render — filter, spread+sort — without `useMemo`, even though `episodesList` can hold 500+ items per CLAUDE.md (`fetches limit=500 for accurate totals`). Typing into the search box re-sorts the entire array on every keystroke.
- **Impact:** Visible lag when searching with hundreds of episodes; every keystroke triggers a 500-item `.filter().sort()` and re-renders 500 EpisodeCards.
- **Effort:** trivial
- **Suggested fix:** Wrap in `useMemo(() => …, [episodesList, search, sort])`; debounce the search input by 150 ms; consider virtualization for >200 items.

### F-PF-06: `EpisodeCard` <img> has no lazy-loading and no decoded sizing
- **Severity:** MEDIUM
- **Location:** `frontend/src/components/episodes/EpisodeCard.tsx:65-71`
- **Evidence:**
```tsx
<img
  src={`/storage/episodes/${episode.id}/output/thumbnail.jpg`}
  alt={episode.title}
  className={`w-full h-full ${isShortsThumb ? 'object-contain' : 'object-cover'}`}
  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
/>
```
No `loading="lazy"`, no `decoding="async"`, no `width`/`height`. With 500 cards in EpisodesList (fetches limit=500) every thumbnail downloads eagerly. Same pattern in `SceneGrid.tsx:59-63` and `Audiobooks/_monolith.tsx`.
- **Impact:** First-load network storm on Episodes/Series pages; images fight with the JS bundle for bandwidth. CLS each time a thumbnail finally renders inside the aspect-ratio box.
- **Effort:** trivial
- **Suggested fix:** Add `loading="lazy" decoding="async"` to all thumbnail `<img>` tags. The `aspect-video` parent already reserves space, so explicit width/height isn't required, but adding them helps the browser plan layout.

### F-PF-07: `JobProgressBar` runs a 1-Hz interval per instance
- **Severity:** MEDIUM
- **Location:** `frontend/src/components/jobs/JobProgressBar.tsx:106-113`
- **Evidence:**
```ts
useEffect(() => {
  const interval = setInterval(() => {
    const timeSinceChange = Date.now() - lastChangeRef.current;
    setIsStale(timeSinceChange > STALE_THRESHOLD_MS);
    setTick((t) => t + 1);
  }, 1000);
  return () => clearInterval(interval);
}, []);
```
Plus `progressKey = JSON.stringify(...)` recomputed every render (line 93). Dashboard, EpisodesList, and per-card compact bars can mount a dozen of these at once during heavy generation.
- **Impact:** N independent 1-Hz timers each dispatching `setTick` + `setIsStale` and re-rendering the bar's parent card. Cumulative 10-20 setStates/sec while a queue is hot.
- **Effort:** small
- **Suggested fix:** Lift the tick to a single shared "now" context (one timer, many subscribers) and gate `setIsStale` updates by previous value. Replace `JSON.stringify` with a numeric hash or skip it — `useEffect` with `[stepProgress]` and a shallow compare is enough.

### F-PF-08: Source `index.html` preloads 7 Google Fonts; built `index.html` only ships 3 — drift between dev and prod
- **Severity:** MEDIUM
- **Location:** `frontend/index.html:14-17` vs. `frontend/dist/index.html:10-13`
- **Evidence:** Source: `Inter, DM Sans, Outfit, Space Grotesk, Fraunces, IBM Plex Mono, JetBrains Mono` (~7 families × 4-5 weights). Dist: only `DM Sans, Outfit, JetBrains Mono`. Vite has no html-manipulating plugin, so the dist must have been edited manually or by a script not in the repo. Either way: dev experience differs from prod, and the source HTML hammers fonts.googleapis.com unnecessarily.
- **Impact:** Dev: ~140 KB extra font download. Prod: still no `<link rel="preload">` for the *critical* Outfit/DM Sans regular weights → FOIT/FOUT on first paint, CLS as headings reflow when Outfit arrives. The `display=swap` mitigates FOIT but not CLS.
- **Effort:** trivial
- **Suggested fix:** Trim source `index.html` to just the three families used in prod (DM Sans / Outfit / JetBrains Mono). Add `<link rel="preload" as="style">` plus a self-hosted woff2 for the two critical families, or at minimum preload the Google Fonts CSS URL. Document the build-time HTML transform if one exists; otherwise treat the source HTML as canonical.

### F-PF-09: VideoPlayer uses `role="application"` — incorrect ARIA role
- **Severity:** MEDIUM
- **Location:** `frontend/src/components/video/VideoPlayer.tsx:236-239`
- **Evidence:** `<div role="application" aria-label="Video player" tabIndex={0}>` wrapping the player.
- **Impact:** `application` tells assistive tech to suspend its own keystroke handling and forward all keys to the app — aggressive, and inappropriate for a media player which already exposes native semantics via the inner `<video>`. Screen-reader users lose normal navigation when focus enters the wrapper.
- **Effort:** trivial
- **Suggested fix:** Use `role="region"` (or simply omit the role and keep `aria-label`); the inner `<video>` is already announced as a media element. Keep `tabIndex={0}` for keyboard activation.

### F-PF-10: VideoPlayer scrubber is a `<div>` — not keyboard accessible
- **Severity:** MEDIUM
- **Location:** `frontend/src/components/video/VideoPlayer.tsx:282-319`
- **Evidence:** The scrubber is `<div ... onClick={handleScrubberClick}>` with no `role="slider"`, no `aria-valuenow/min/max`, no arrow-key handling on the bar itself (arrow seek is wired on the outer wrapper via keydown, but a screen-reader user can't perceive position).
- **Impact:** Users on AT have no announced playhead position; pointer-only scrub.
- **Effort:** small
- **Suggested fix:** Replace with `<input type="range" aria-label="Seek" min={0} max={duration} value={currentTime}>` styled to look like the bar, or apply `role="slider" aria-valuemin/max/now aria-valuetext={formatTime(currentTime)}`.

### F-PF-11: Dialog focus trap is incomplete — Tab can leave the panel
- **Severity:** MEDIUM
- **Location:** `frontend/src/components/ui/Dialog.tsx:73-78`
- **Evidence:** Focus only moves to `panelRef.current` on open. There is no Tab/Shift-Tab loop guard, and no return-focus-to-trigger on close.
- **Impact:** Keyboard users can Tab out of the modal into the (visually obscured) page below; on close, focus lands on `<body>`. Fails WCAG 2.1.2 (No Keyboard Trap — actually we want the opposite, a *deliberate* trap inside the modal).
- **Effort:** small
- **Suggested fix:** Use Radix `Dialog` (already in package indirectly via other Radix primitives) or implement a small focus-trap: query focusable descendants of `panelRef`, wrap Tab/Shift-Tab. Save `document.activeElement` on open, restore on close.

### F-PF-12: `text.tertiary` (#717179) used widely on `bg-base` — borderline contrast
- **Severity:** MEDIUM
- **Location:** Tokens in `frontend/src/styles/design-tokens.ts:28` and `globals.css:30`; usage across all pages (`text-txt-tertiary` for timestamps, helper text, percentages).
- **Evidence:** Design-system Appendix A claims tertiary on `bg.base` is 3.5:1 ("AA Large only"). The implementation uses #717179 which the comment annotates as 4.61:1 on bg.base, but on top of the dock's `bg-bg-elevated/90` plus `backdrop-blur-xl` overlay (varies with content underneath), real contrast drops below 4.5:1 for body text. ActivityMonitor uses `text-[10px]` text-txt-tertiary repeatedly (lines 623, 628, 646, 514) — that's smaller than the AA-Large threshold (18 px / 14 px bold) so it must hit 4.5:1.
- **Impact:** Failing WCAG AA for the small-text status strip and helper rows. Especially noticeable in the activity dock where the 10/11 px tertiary text sits on a translucent surface.
- **Effort:** small
- **Suggested fix:** Either bump tertiary to ~#8A8A92 (≥4.7:1 even with translucency) or stop using tertiary for text under 14 px on glass surfaces; reserve it for icon hints/dividers.

### F-PF-13: ActivityMonitor `expanded` toggle re-renders every key press globally via Layout's keydown listener — not strictly an issue, but: collapsed state defaults to `false` on every mount
- **Severity:** LOW
- **Location:** `frontend/src/components/ActivityMonitor.tsx:118-125`
- **Evidence:** `useState<boolean>(() => { return false; })` — the IIFE comment says "honor whatever the user had on the previous render" but the body always returns `false`. There's no localStorage read.
- **Impact:** User preference for expanded/collapsed is forgotten on every navigation/refresh.
- **Effort:** trivial
- **Suggested fix:** Read/write `localStorage.getItem('sf_activity_dock_expanded')` like the priority key does.

### F-PF-14: WebSocket reconnect backoff is reasonable; but `useActiveJobsProgress` mounts twice (Dashboard + ActivityMonitor + EpisodesList all subscribe) and each opens its own socket
- **Severity:** LOW
- **Location:** `frontend/src/lib/websocket.ts:187-229`; usages in `Dashboard.tsx:32`, `ActivityMonitor.tsx:22`, `EpisodesList.tsx:23`.
- **Evidence:** Each `useActiveJobsProgress()` call constructs its own `ProgressWebSocket` to `/ws/progress/all`. With three components mounted together (Dashboard navigates, ActivityMonitor stays), backend gets 2-3 concurrent identical subscriptions per browser tab.
- **Impact:** Wasted server fan-out and triple-counted re-renders for the same payload. Not a leak — cleanup on unmount works — but inefficient.
- **Effort:** small
- **Suggested fix:** Hoist the connection to a `ProgressProvider` context; all hooks subscribe to its single shared state. Standard pattern with React Context + useSyncExternalStore.

### F-PF-15: WebSocket reconnect: `closed = true` on cap reached, no manual reset path
- **Severity:** LOW
- **Location:** `frontend/src/lib/websocket.ts:88-101`
- **Evidence:** Once `retryCount >= maxRetries`, `this.closed = true` and the socket gives up forever. No `reconnect()` public method, no exponential reset on user action.
- **Impact:** If the worker was down on app load and comes back later, the user must hard-refresh to get progress streaming back. The auth-failure path (lines 65-68) is correct; the budget-exhaustion path is too aggressive for transient network blips.
- **Effort:** small
- **Suggested fix:** Expose a `reconnect()` method on the hook return; call it on `online` event or when the user clicks a "reconnect progress stream" button next to the LiveStatus indicator.

### F-PF-16: Dashboard `seriesById = Object.fromEntries(...)` recreates every render → invalidates EpisodeCard memoization
- **Severity:** LOW
- **Location:** `frontend/src/pages/Dashboard.tsx:194`
- **Evidence:** `const seriesById = Object.fromEntries(seriesList.map((s) => [s.id, s.name]));` at top-level of render. Same shape every time but new identity.
- **Impact:** Even if `EpisodeCard` were wrapped in `React.memo`, the `seriesName` prop derived from this lookup would defeat it. Compounds with F-PF-04.
- **Effort:** trivial
- **Suggested fix:** `useMemo(() => Object.fromEntries(...), [seriesList])`.

### F-PF-17: `EpisodesList` declares `fetchData` with an outdated `toast` dep
- **Severity:** LOW
- **Location:** `frontend/src/pages/EpisodesList.tsx:121`
- **Evidence:** `}, [statusFilter, seriesFilter]);` — `toast` is captured from closure but not in deps; eslint-react-hooks would flag it. (Dashboard.tsx:153 has the opposite — toast IS in deps, which causes re-fetch on every Toast provider re-render.)
- **Impact:** Stale closures over `toast` ref are usually harmless because `toast` from useToast is stable, but the inconsistency is a footgun.
- **Effort:** trivial
- **Suggested fix:** Pass `toast` from a ref or stabilize at the hook level; align both pages to the same pattern.

### F-PF-18: `ThemeProvider` mutates `html.style` on every render via `useEffect`s — confirmed safe but worth noting
- **Severity:** NIT
- **Location:** `frontend/src/lib/theme.tsx:371`
- **Evidence:** `html.style.setProperty('--font-display', preset.fontDisplay);` runs in effect. Theme changes are rare so this is fine.
- **Impact:** None in practice.
- **Effort:** N/A
- **Suggested fix:** No action.

### F-PF-19: `JobProgressBar` non-compact variant computes `formatElapsed` in render but only updates via the 1-Hz tick
- **Severity:** NIT
- **Location:** `frontend/src/components/jobs/JobProgressBar.tsx:64-72, 250-254`
- **Evidence:** `formatElapsed(startedAt)` is called inside JSX without memoization; that's fine because it's cheap, but combined with F-PF-07 the elapsed text is the *reason* the tick exists for non-compact bars. Compact bars don't need it but still tick.
- **Impact:** Minor wasted renders.
- **Effort:** trivial
- **Suggested fix:** Skip the tick effect when `compact === true` or `startedAt == null`.

### F-PF-20: Visual drift — `JobProgressBar` does not implement segmented widths from design system
- **Severity:** NIT
- **Location:** `frontend/src/components/jobs/JobProgressBar.tsx:196-225` vs. `docs/frontend/design-system.md:130-138`
- **Evidence:** Design system specifies weighted segments (Script 10 %, Voice 15 %, Scenes 30 %, …). Implementation uses `flex-1` on every segment, giving each step equal width.
- **Impact:** Visual perception of pipeline progress is off — Scenes (slowest step in reality) reads as same width as Thumbnail. Doesn't break anything, just departs from the spec.
- **Effort:** trivial
- **Suggested fix:** Apply `style={{ flexBasis: `${weight}%`, flexGrow: 0 }}` per step, or `flex: '0 0 <weight>%'`.

### F-PF-21: `SceneGrid` aspect — design system says scene cards are 9:16; implementation uses `aspect-video` (16:9)
- **Severity:** NIT
- **Location:** `frontend/src/components/scenes/SceneGrid.tsx:57` vs. `docs/frontend/design-system.md:200-209`
- **Evidence:** `<div className="aspect-video bg-bg-base relative overflow-hidden">` — design system specifies `aspect-ratio: 9 / 16` for scene cards. Long-form (16:9) episodes need this to be aspect-aware anyway.
- **Impact:** Shorts users see letterboxed scenes in the grid. Long-form is fine.
- **Effort:** small
- **Suggested fix:** Make aspect prop-driven: `aspect-[9/16]` for shorts, `aspect-video` for long-form, derived from `episode.content_format`.

### F-PF-22: VideoPlayer omits `<track>` cleanup when toggling captions off
- **Severity:** NIT
- **Location:** `frontend/src/components/video/VideoPlayer.tsx:250-258`
- **Evidence:** The `<track>` element is rendered conditionally on `captionsOn`; toggling causes React to unmount/remount the track, which triggers the browser to re-fetch the .vtt every time.
- **Impact:** Repeated network requests when a user toggles CC.
- **Effort:** trivial
- **Suggested fix:** Always render the `<track>`, but toggle the underlying `videoRef.current.textTracks[0].mode = captionsOn ? 'showing' : 'hidden'`.

### F-PF-23: Layout polls `jobsApi.active()` every 10 s in addition to ActivityMonitor's 3-s poll
- **Severity:** NIT
- **Location:** `frontend/src/components/layout/Layout.tsx:59-78` and `ActivityMonitor.tsx:142-192`
- **Evidence:** Layout polls active jobs to feed `activeJobCount` to the Header badge; ActivityMonitor polls the same endpoint at a higher rate with overlapping data.
- **Impact:** Two timers per page covering the same data; minor backend chatter.
- **Effort:** trivial
- **Suggested fix:** Lift active-job state to a context provider; both components subscribe.

### F-PF-24: `react.StrictMode` is enabled (`main.tsx:11`) — good — but combined with WebSocket constructors in effects, every dev mount opens then immediately closes a socket
- **Severity:** NIT
- **Location:** `frontend/src/main.tsx:11`, `frontend/src/lib/websocket.ts:163-178`
- **Evidence:** Standard StrictMode double-mount behavior. Cleanup is correct so no leak; just noisy in dev.
- **Impact:** Dev console noise; backend pubsub sees double-subscribe/unsubscribe per mount.
- **Effort:** N/A
- **Suggested fix:** Accept as-is; add a small `useEffect` log gate if it bothers contributors.

### F-PF-25: lucide-react imports look healthy — per-icon chunks confirm tree-shaking works
- **Severity:** N/A (positive observation)
- **Location:** `frontend/dist/assets/*-*.js` per-icon chunks
- **Evidence:** Each icon emits its own ~300-700 byte chunk. The named-import pattern in source (`import { Activity, ChevronUp, … } from 'lucide-react'`) is correctly tree-shaken.
- **Impact:** None.
- **Effort:** N/A
- **Suggested fix:** Keep using named imports; never `import * as Icons from 'lucide-react'`.

---

## Top 5 by ROI

1. **F-PF-06 — Add `loading="lazy" decoding="async"` to all thumbnail `<img>` tags.** Trivial 4-character change × ~6 locations. Eliminates the EpisodesList load storm.
2. **F-PF-05 — Wrap `visibleEpisodes` in `useMemo` and debounce search.** Trivial. Largest single perceived-perf win on the most-used page.
3. **F-PF-01 — Split `lib/api/_monolith.ts` into per-domain modules.** Medium effort, cuts main bundle by 20-30 % once Settings/YouTube API surfaces stop landing in the entry chunk.
4. **F-PF-03 — Memoize ActivityMonitor and decouple polling from WS updates.** Medium. Stops the always-mounted dock from being the app's hottest re-render path during generation.
5. **F-PF-09 / F-PF-10 / F-PF-11 — A11y triage on VideoPlayer + Dialog.** Small effort each, three concrete WCAG/AT fixes that ship together: drop `role="application"`, make scrubber a slider, complete the dialog focus trap.

## Don't fix (intentional)

- **Glass-morphism, gradient accents, noise overlay, backdrop-blur on Sidebar/Header/ActivityMonitor.** Brand identity per CLAUDE.md.
- **Outfit + DM Sans typography pairing.** Brand.
- **`React.lazy` on every routed page.** Verified in `App.tsx:16-36` — every page in the routes table is `lazy()`-imported. The only non-lazy components are the layout shell (Layout/EditorLayout/Sidebar/Header/ActivityMonitor), the `LicenseGate`, `LoginGate`, theme/toast/tooltip providers, and the tiny inline `YouTubeCallback` (which is intentionally not lazy per the comment at App.tsx:51-53). No drift from the CLAUDE.md claim.
- **lucide-react named imports / per-icon chunks.** Working as intended.
- **`display=swap` on Google Fonts.** Correct choice for FOUT-tolerant brand fonts.
- **StrictMode double-effects in dev.** Working as designed; do not disable.
- **WebSocket retry budget cap when never-connected.** Deliberate per the comment at `websocket.ts:25-30` — prevents 4xx-handshake spam.
