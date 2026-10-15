# claude-mobile-be: notes for Claude Code

The Mac-side server of Claude Mobile. The phone app is the sibling repo `../claude-mobile-app`. Read [README.md](README.md) first; this file adds the decisions, the current state and the internals.

## Decisions (agreed with the owner, don't re-litigate)
- **Privacy:** phone ↔ Mac only, over Tailscale. Not Claude Remote Control, no relay service. The server binds to the Tailscale IP and uses one bearer token (`~/.claude-mobile/token`, mode 600), paired once via QR.
- **Stack:** Node 22+, TypeScript, **Express 5**, `ws`, `@anthropic-ai/claude-agent-sdk`, zod. pnpm workspace: the root is the server; `protocol/` is the shared types package, owned by this repo and linked from the app.
- **Scope:** only the Claude desktop app's Code-tab sessions are shown (not VS Code or CLI sessions). Tool approvals happen on the phone only. Desktop-only features are out of scope.
- **Voice (next):** speech-to-text through the same service Claude Code's `/voice` uses, with the phone's speech recognition as fallback. Text-to-speech is out of scope.

## State
- **Done:**
  - browse: projects, filtered sessions, paged history
  - live chat over `/api/ws`: streaming, interrupt, live model/effort/mode, slash commands, approvals, AskUserQuestion
  - new chats from the phone, registered in the desktop sidebar
  - 24 vitest tests
- **Next:**
  - voice proxy (phase 3)
  - launchd auto-start (phase 4)
  - confirm that phone-started chats appear in the desktop sidebar after a desktop app restart

## Internals worth knowing
- **Desktop records:** `~/Library/Application Support/Claude/claude-code-sessions/<account>/<org>/local_<uuid>.json` (`cliSessionId`, cwd, title, model, effort, permissionMode, isArchived, isStarred). The format is undocumented and parsed leniently. `deleted_<uuid>` tombstones hide sessions.
  - `registerDesktopSession` copies app-wide fields from the newest *valid* record and only ever adds files (temp file + `link`).
  - Folderless chats live in `scratch-workspaces/<account>/<org>/scratch-<date>-<hex>` and are grouped as project `no-folder`.
- **Transcripts:** `~/.claude/projects/<cwd with non-alphanumerics as ->/<cliSessionId>.jsonl`, searched across folders when a session was relocated.
  - The transcript is a tree: follow the newest leaf via `parentUuid`. Parallel tool results can sit on sibling branches, so they're looked up across all entries.
  - `/context`-style output is a `system` entry with subtype `local_command`.
- **LiveSession (`src/live.ts`):**
  - one streaming-input SDK query per chat: `resume`, or `sessionId` for new chats
  - `includePartialMessages`, with `canUseTool` routed to the phone
  - user messages carry a `uuid` that also lands in the transcript, so the app dedupes live items against history
  - a snapshot includes the current turn's items for phones that reconnect
  - idle queries close after 15 min
  - effort changes live via `applyFlagSettings({ effortLevel })`
- **Catalog:** commands and models come from a short query that never sends a message, so it writes no transcript.
- **Activity time:** the maximum of the desktop `lastActivityAt` and the transcript mtime, because the desktop doesn't update its record for turns it didn't run.

## Working here
- `pnpm test`, `pnpm typecheck` (also typecheck the app after changing `protocol/`).
- Experiment in a throwaway desktop chat, never in real ones.
- Use `pnpm start`, not `pnpm dev`: the watcher restarts the server, which ends chats in progress.
- Commit only when asked. No personal data (IPs, home paths, account names) in committed files: the repo is public.
