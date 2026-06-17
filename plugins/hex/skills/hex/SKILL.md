---
name: hex
description: Search Hex projects, ask Hex Threads questions, and use the Hex CLI. Use when the user explicitly references Hex, Hex projects, Hex dashboards, Hex data apps, Hex CLI, Hex Threads, or asks to search an existing Hex workspace asset.
---

# Hex

Use Hex when the user explicitly references Hex, Hex projects, Hex dashboards, Hex data apps, Hex analyses, Hex CLI, or Hex Threads, or when they ask to search an existing Hex workspace asset.

Do not use Hex as the default owner for generic company metrics, KPI reporting, dashboard creation, report generation, metric diagnostics, or notebook-backed analysis. Route those through the relevant analytics or Data Science skills unless the user asks to do the work in Hex.

## Workflow

1. Classify the request.
   Use Hex only for explicit Hex intent or existing Hex asset discovery. Generic metrics, KPI, dashboard, report, notebook, or company-data prompts belong to the relevant analytics or Data Science skills unless the user names Hex as the target surface. Do not use Hex for generic web research, uploaded-file-only analysis, or questions about how Hex itself works unless the user explicitly wants to search their Hex workspace.

2. Search existing projects first.
   Use [$Hex](app://connector_690a9430a270819196671dcb4c95898e) `search_projects` with the strongest query terms from the user's request. Present relevant project links before starting a new Thread.

3. Use the Hex CLI for direct project, cell, and run operations.
   When the user asks to inspect or change concrete Hex project contents, prefer the terminal `hex` CLI if it is installed and authenticated. Start with `hex auth status`; if it is not authenticated, ask the user to run `hex auth login` or provide a safe non-interactive auth path. For unfamiliar CLI operations, run `hex --help` or `hex <command> <subcommand> --help` and follow the current CLI argument shape. Use `--json` for CLI commands when available so results can be checked precisely.

   Good CLI fits include:
   - `hex project list`, `hex project get`, and `hex project export`
   - `hex cell list` and `hex cell get`
   - `hex run status` and `hex run list`
   - `hex cell update` or `hex cell run` when the user explicitly asks to edit or execute a specific cell

   Treat CLI create, update, delete, import, run, and cancel commands as write or execution actions. Before doing one, confirm the target project or cell and the exact change unless the user has already explicitly requested that operation in the current turn. Never print Hex tokens or credentials.

4. Use existing threads when provided.
   If the user provides a Hex Thread id or link, use [$Hex](app://connector_690a9430a270819196671dcb4c95898e) `get_thread` to read the thread state and messages before answering or proposing a follow-up.

5. Confirm before Thread write actions.
   `create_thread` and `continue_thread` can start or modify Hex Thread work. Before calling either tool, tell the user what prompt will be sent to Hex and ask for confirmation. After a write call, poll with `get_thread` until the thread is complete or until the user asks you to stop.

6. Answer with provenance.
   When project search returns results, include the project names and links. When using a thread, summarize the final Hex response and include the Hex Thread link or id when available. When using the CLI, include the command family used, the relevant project/cell/run ids, and the final status.

## Good Fits

- `Find the Hex dashboard for campaign segmentation.`
- `What Hex projects mention churn analysis?`
- `Ask Hex to analyze revenue drivers for the last quarter.`
- `Check this Hex Thread and summarize the result.`
- `Find the Hex project that has our pipeline forecast.`
- `Use the Hex CLI to list cells in this project.`
- `Update this Hex SQL cell and run it.`

## Negative Cases

- Do not use Hex for general market questions, web-only questions, or product documentation lookup.
- Do not use Hex just because the word `data` appears if the user supplied a local file that can be analyzed directly.
- Do not use Hex just because a prompt mentions metrics, KPIs, dashboards, reports, or notebooks. Use the relevant analytics or Data Science skills unless the user asks for Hex.
- Do not use Hex for permission, billing, or workspace-admin questions unless the user asks to search a Hex project or thread about that topic.

## Safety

- Start with read-only operations: `search_projects` and `get_thread`.
- Treat `create_thread` and `continue_thread` as writes.
- For CLI work, start with read-only commands such as `hex auth status`, `hex project get`, `hex cell get`, and `hex run status`.
- Treat CLI create, update, delete, import, run, and cancel commands as writes or executions.
- Never invent project names, thread status, SQL, charts, or analysis results.
