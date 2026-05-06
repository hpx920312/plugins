---
name: prism
description: Use when the user wants to work with OpenAI Prism projects from Codex: inspect project files, download a project locally, upload edits, or keep a local folder synchronized with Prism. Trigger on Prism project, Prism file, pull, push, or sync requests.
---

# Prism

Use Prism as a remote project workspace that Codex can inspect, materialize locally, and synchronize safely.

## How to talk about Prism

When the user asks what Prism can do, answer in product terms first:

- organize LaTeX work into Prism projects,
- inspect the files in a project,
- download current project contents locally,
- upload changed files back to Prism,
- keep a local folder synchronized with the remote project.

Do **not** lead with Supabase, Y-Sweet, bearer tokens, object ids, upload-plan/finalize calls, or sync manifests unless the user asks how the system works or you are debugging a concrete failure.

Prefer plain task language:

- “show files in the project” instead of “read the Y-Sweet document tree”
- “download this file” instead of “resolve the signed blob redirect”
- “sync this folder” instead of “run a local/remote manifest comparison”
- “both changed” instead of “diverged baseline state”

## Use the right Prism surface

Use the Prism MCP for headless project/file work:

- find or inspect projects,
- read files,
- download files or whole projects,
- create new text files,
- write generated text into existing project files,
- upload external local files,
- check sync status,
- pull or push a local folder.

Use a live Prism/browser workflow only when the user explicitly asks to interact with the live editor, inspect the rendered UI, compile in the live app, or debug behavior that only exists in the browser surface. Do not choose browser driving for ordinary file transport or folder sync.

## Default workflows

- **Show projects**: use `list_projects`.
- **Open one project**: use `get_project` after the project is explicit.
- **Show project files**: use `list_files` before reading contents.
- **Inspect a file**: use `read_file` only after the file path is explicit or the needed file has been identified from metadata.
- **Download one file**: use `download_file`.
- **Create one new text file**: use `create_file`.
- **Write generated text**: use `write_file`.
- **Upload one external local file**: use `upload_file`.
- **Sync a folder**:
  1. establish which Prism project the folder belongs to,
  2. if the folder has no prior sync state and the user did not identify a project, do not guess from all projects; ask them to choose one,
  3. run `sync_status` before mutating anything,
  4. use `sync_pull` for remote-only / remote-newer changes,
  5. use `sync_push` for local-only / local-newer changes,
  6. summarize changed files and remaining conflicts in plain language.

## Internal tool routing

The Prism MCP v1 surface is:

- `list_projects`
- `get_project`
- `list_files`
- `read_file`
- `download_file`
- `create_file`
- `write_file`
- `upload_file`
- `sync_status`
- `sync_pull`
- `sync_push`

Use the narrowest tool that satisfies the request. Do not download an entire project when the user only needs one file. Do not read full file contents when project/file metadata is enough.

## Project and file model

Treat a Prism project as one remote workspace with two user-visible kinds of content:

- text files and folders that make up the project tree,
- uploaded binary assets such as figures or PDFs referenced by that tree.

The user should not need to know the implementation split. Generated project
text uses Prism's document path; that includes generated SVG when the task is to
author SVG source. External local files use Prism's upload flow and then attach
to the same project tree under a stable Prism file id. Folder sync treats
decodable text as project text and uploads binary assets as file refs. Your job
is to preserve the whole project view while speaking in terms of project folders
and files.

## Safe sync model

Do not pretend a plain upload/download loop is sync. A correct sync flow compares the current local folder, the current remote project, and the last successful common state.

Use the sync tools conservatively:

1. **Remote changed only**: pull the remote file.
2. **Local changed only**: push the local file.
3. **Both changed**: report a conflict; do not overwrite either side automatically.
4. **Remote-only / local-only files**: copy them in the requested direction when that is what the user asked for.

For conflicts:

- keep the local file untouched by default,
- materialize or report the remote variant separately when the tool provides it,
- require an explicit follow-up choice before keeping local, keeping remote, or keeping both.

Do not silently delete local or remote files as a side effect of a normal pull/push. Treat deletions as explicit user intent.

## Output discipline

After Prism work, report:

- which project you operated on,
- which files were read, downloaded, uploaded, or changed,
- what sync action happened,
- whether conflicts remain.

For ordinary successful sync, avoid dumping internal ids, manifests, signed URLs, or backend route names. Surface them only when the user asks for debugging details.

## Examples

- “Show my Prism projects” -> `list_projects`
- “What files are in this paper?” -> `list_files`
- “Read `main.tex`” -> `read_file`
- “Download `references.bib`” -> `download_file`
- “Create `sections/methods.tex`” -> `create_file`
- “Write this generated SVG into `figures/diagram.svg`” -> `write_file`
- “Upload this external figure file to the Prism project” -> `upload_file`
- “Sync this local folder with my Prism paper” -> `sync_status`, then `sync_pull` or `sync_push` based on the requested direction and conflict state
