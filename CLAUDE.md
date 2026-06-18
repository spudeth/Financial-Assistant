# Financial Assistant — Working Agreement

## What this app is
A voice-driven financial assistant: the user talks to it like a chat assistant, and it tracks their transactions/spending. The "brain" (Claude API integration + a Postgres database schema designed for those calls) is being built separately by the user and will be wired in later — this repo is currently just the native iOS app's UI (chat interface, history, settings/profile, onboarding).

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

## Other key information 
- This is a rebuild, user has build 80% of the entire project already, but the app was inconsistant and glitchy. Many componants are already built, save time by asking user for the previous code if applicable