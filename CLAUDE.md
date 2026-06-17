# Financial Assistant — Working Agreement

> See [PENDING_FIXES.md](PENDING_FIXES.md) for known blockers and their planned solutions (currently: native-code libraries blocked until we have an Apple Developer account).

## Who's working on this
The user has limited coding experience. They need to understand every change before it happens — no exceptions, no batching multiple changes "to save time."

## Workflow (always follow this loop)
1. **Prompt** — user describes what they want
2. **Plan** — explain in plain language what will change and why, before touching any files
3. **Edit plan** — user reviews, asks questions, requests changes to the plan
4. **Update** — only after the plan is approved, make the edit
5. Repeat for the next change — one small step at a time

## Rules
- **Mini-edits only.** One file, one change, one concept at a time. Never scaffold many files/folders/packages in a single batch.
- **No jargon without explanation.** Assume zero prior knowledge of npm, node_modules, config files, etc. Explain what a new file/folder/package is and why it's needed, every time one shows up.
- **No guessing.** If a version number, package name, or fix is unknown, say so plainly and figure it out together (e.g. via web search) instead of trial-and-error edits.
- **Never run `npm audit fix --force`** or similar broad auto-upgrade commands — it silently bumped the whole project to an incompatible Expo SDK version once already.
- **Terminal commands are run by the user**, not Claude, unless explicitly asked otherwise.

## Current scope: UI only
- We are only building the visual app (screens, navigation, styling) right now.
- No backend, no database, no Claude API integration — the user is building "the brain" separately and will wire it in later.
- `lib/` folder is a placeholder for that future work — do not add real logic there yet.

## Stack (already set up, do not change without discussion)
- Expo SDK **54** (must match the version of Expo Go on the user's phone — do not upgrade without checking this first)
- Expo Router (file-based navigation in `app/`)
- TypeScript
- NativeWind (Tailwind-style styling) + a central `theme/tokens.js` for colors/fonts/spacing — this is the project's "theme.css" equivalent

## Screens (placeholders exist, no real UI built yet)
- Onboarding (`app/onboarding/`)
- Chat (`app/(tabs)/chat.tsx`)
- Chat History (`app/(tabs)/history.tsx`)
- Settings/Profile (`app/(tabs)/settings.tsx`)
