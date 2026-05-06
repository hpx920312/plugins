# Prism Plugin

Work with OpenAI Prism projects from Codex: find projects, inspect files, download or upload project contents, and keep a local folder synchronized with a Prism project.

Learn more about Prism at <https://openai.com/prism>.

## Bundled skill

The bundled `$prism` skill teaches Codex how to use the Prism MCP product surface safely:

- inspect project metadata before reading full file contents,
- pull and push through explicit sync flows,
- keep project sync conservative when both local and remote files changed,
- and use live Prism/browser workflows only when the user actually asks for live UI or compile interaction.

## Local MCP

The plugin ships a local stdio MCP server at
`scripts/prism_mcp_server.mjs`. It:

- reads the user's existing Codex access token from `$CODEX_HOME/auth.json` or
  `~/.codex/auth.json`,
- exchanges it with the Prism BFF for a short-lived Prism session,
- uses the text/Y-Sweet path for generated text and sync, and the upload flow for
  external local files/assets,
- exposes `list_projects`, `get_project`, `list_files`, `read_file`,
  `download_file`, `create_file`, `write_file`, `upload_file`, `sync_status`,
  `sync_pull`, and `sync_push`,
- and keeps sync state in a local `.prism-sync.json` manifest without storing
  Prism refresh credentials.

By default the MCP talks to `https://prism.openai.com`. For local development,
set `PRISM_BASE_URL=http://localhost:3000` or pass
`--prism-base-url http://localhost:3000`.
