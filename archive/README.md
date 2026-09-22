# archive/

An earlier browser-based version of this project, kept only for reference.

- `server.js` — an HTTP + SSE server that exposed the OS readings as a JSON API
- `index.html` — a single-page dashboard that consumed it

**This does not run against the current code.** The project is a terminal
program now, and `lib/metrics.js` and `lib/processes.js` have since been cut
back to the Phase 1 scope, so the endpoints `server.js` expects (disk, network,
sessions, signals) no longer exist.

Nothing in the working project imports anything from this folder. To see this
version running, check out commit `adaf1d9`.
