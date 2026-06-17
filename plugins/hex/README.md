# Hex plugin

`hex` is a Codex plugin wrapper for the Hex ChatGPT app / MCP connector and the Hex CLI.

It currently includes:

- one Hex routing skill
- a minimal `.app.json` connector manifest

## Commands

- `hex`
  Search Hex projects, use Hex Threads, and use the terminal Hex CLI when the user explicitly asks for Hex or an existing Hex workspace asset.

## Notes

- Use `search_projects` before creating a new thread when the user is looking for existing Hex work.
- Treat `create_thread` and `continue_thread` as write actions that require user confirmation and an appropriate Hex workspace context.
- Prefer the terminal `hex` CLI for concrete project, cell, and run operations when it is installed and authenticated, especially `hex project`, `hex cell`, and `hex run` readbacks.
- Start CLI workflows with `hex auth status`; use `hex --help` or subcommand help for current argument shapes; and use `--json` where available.
- Treat CLI create, update, delete, import, run, and cancel commands as write or execution actions. Confirm the target and exact change unless the user already explicitly requested it.
- Do not use Hex as the default owner for generic company metrics, KPI reporting, dashboard creation, report generation, metric diagnostics, or notebook-backed analysis. Route those through the relevant analytics or Data Science skills unless the user asks to do the work in Hex.
- Use Hex for explicit Hex workspace questions, not for generic web search or Hex product documentation questions.
