# HexSlither / DuelSeries — Project Context

## Multiplayer Game Context
This is a multiplayer snake game (DuelSeries/HexSlither) using Socket.io with room scoping. Key concerns: client-server state sync, border dynamics, persistent leaderboard, rendering smoothness. Avoid client-side simulation rewrites; the server is authoritative.

## Workspace Verification
Before reading or editing files, verify the active workspace matches this project (should contain `server/`, `public/js/`, `shared/constants.js`, `server.js`). If there's a mismatch, STOP and ask for the correct path.

## Visual/Rendering Changes
- When the user references a visual artifact (e.g., 'scales', 'lines', 'stripes', 'glow'), ASK for clarification by describing 2-3 possible interpretations BEFORE making code changes.
- Never do full rewrites of rendering/simulation code without explicit approval; prefer minimal incremental edits.
- Any change touching more than ~50 lines or rewriting a subsystem must be presented as a plan first and wait for approval before implementing.
