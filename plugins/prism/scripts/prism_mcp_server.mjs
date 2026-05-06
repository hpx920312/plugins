import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SERVER_NAME = "prism";
const SERVER_VERSION = "0.1.0";
const DEFAULT_PRISM_BASE_URL = "https://prism.openai.com";
const REQUEST_TIMEOUT_MS = 300_000;
const SESSION_REFRESH_SKEW_MS = 60_000;
const DEFAULT_SYNC_MANIFEST_NAME = ".prism-sync.json";
const SYNC_MANIFEST_VERSION = 1;
const DEFAULT_SYNC_IGNORED_NAMES = new Set([
  ".git",
  DEFAULT_SYNC_MANIFEST_NAME,
]);
const TEXT_FILE_EXTENSIONS = new Set([
  ".bib",
  ".cls",
  ".csv",
  ".json",
  ".md",
  ".sty",
  ".tex",
  ".txt",
  ".yaml",
  ".yml",
]);

class PrismMcpAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "PrismMcpAuthError";
  }
}

class PrismMcpBackendError extends Error {
  constructor(message) {
    super(message);
    this.name = "PrismMcpBackendError";
  }
}

class PrismBackend {
  constructor({ authPath, prismBaseUrl }) {
    this.authPath = authPath;
    this.baseUrl = prismBaseUrl.replace(/\/+$/, "");
    this.cachedSession = null;
  }

  async listProjects({ limit, query } = {}) {
    const searchParams = new URLSearchParams();
    if (query) searchParams.set("q", query);
    if (limit) searchParams.set("limit", String(limit));
    return this.fetchJson({
      context: "Prism project list",
      method: "GET",
      path: `/api/codex/projects${
        searchParams.size > 0 ? `?${searchParams.toString()}` : ""
      }`,
    });
  }

  async getProject(projectId) {
    return this.fetchJson({
      context: "Prism project get",
      method: "GET",
      path: `/api/codex/projects/${encodeURIComponent(projectId)}`,
    });
  }

  async listFiles(projectId) {
    return this.fetchJson({
      context: "Prism project file list",
      method: "GET",
      path: `/api/codex/projects/${encodeURIComponent(projectId)}/files`,
    });
  }

  async readFile(projectId, filePath) {
    const query = new URLSearchParams({ path: normalizeProjectPath(filePath) });
    return this.fetchJson({
      context: "Prism project file read",
      method: "GET",
      path: `/api/codex/projects/${encodeURIComponent(
        projectId,
      )}/files?${query.toString()}`,
    });
  }

  async writeTextFile(projectId, filePath, text) {
    return this.fetchJson({
      body: {
        kind: "text",
        path: normalizeProjectPath(filePath),
        text,
      },
      context: "Prism project text upload",
      method: "PUT",
      path: `/api/codex/projects/${encodeURIComponent(projectId)}/files`,
    });
  }

  async createTextFile(projectId, filePath, text) {
    return this.fetchJson({
      body: {
        kind: "text",
        path: normalizeProjectPath(filePath),
        text,
      },
      context: "Prism project text create",
      method: "POST",
      path: `/api/codex/projects/${encodeURIComponent(projectId)}/files`,
    });
  }

  async uploadBinaryFile(projectId, localPath, filePath) {
    const bytes = await fs.readFile(localPath);
    const fileName = path.basename(filePath);
    const fileId = randomUUID();
    const contentType = guessMimeType(fileName);
    const objectId = await this.uploadBinaryViaDirectFlow({
      bytes,
      contentType,
      fileId,
      fileName,
      projectId,
    });

    return this.fetchJson({
      body: {
        kind: "binary_reference",
        path: normalizeProjectPath(filePath),
        // Y-Sweet stores the stable app UUID; Supabase project authz stores the
        // storage object id from whichever upload flow created the bytes.
        fileId,
        objectId,
      },
      context: "Prism binary attach",
      method: "PUT",
      path: `/api/codex/projects/${encodeURIComponent(projectId)}/files`,
    });
  }

  async uploadBinaryViaServerRoute({
    bytes,
    contentType,
    fileId,
    fileName,
    projectId,
  }) {
    const uploadBody = new FormData();
    uploadBody.set("file", new Blob([bytes], { type: contentType }), fileName);
    uploadBody.set("fileId", fileId);
    uploadBody.set("projectId", projectId);
    uploadBody.set("requireProjectEditAccess", "true");

    const uploaded = await this.fetchJson({
      body: uploadBody,
      context: "Prism binary upload",
      method: "POST",
      path: "/api/project-files/upload",
    });
    return requiredString(
      uploaded,
      "id",
      "Prism binary upload response missing id",
    );
  }

  async uploadBinaryViaDirectFlow({
    bytes,
    contentType,
    fileId,
    fileName,
    projectId,
  }) {
    let mirroredObjectId = null;
    try {
      const plan = await this.fetchJson({
        body: {
          contentType,
          fileId,
          fileName,
          projectId,
          requireProjectEditAccess: true,
        },
        context: "Prism binary upload plan",
        method: "POST",
        path: "/api/project-files/upload-plan",
      });
      const sedimentFileId = requiredString(
        plan,
        "fileId",
        "Prism binary upload plan missing fileId",
      );
      const uploadUrl = requiredString(
        plan,
        "uploadUrl",
        "Prism binary upload plan missing uploadUrl",
      );
      const etag = requiredString(
        plan,
        "etag",
        "Prism binary upload plan missing etag",
      );

      const [mirrorResult, sedimentResult] = await Promise.allSettled([
        this.uploadSupabaseMirror({
          bytes,
          contentType,
          fileId,
        }),
        this.uploadToSignedUrl({
          bytes,
          contentType,
          uploadUrl,
        }),
      ]);

      if (mirrorResult.status === "rejected") {
        throw mirrorResult.reason;
      }
      mirroredObjectId = mirrorResult.value;
      if (sedimentResult.status === "rejected") {
        throw sedimentResult.reason;
      }

      await this.fetchJson({
        body: {
          etag,
          fileUuid: fileId,
          legacyObjectId: mirroredObjectId,
          legacyObjectName: fileId,
          projectId,
          requireProjectEditAccess: true,
          sedimentFileId,
        },
        context: "Prism binary finalize",
        method: "POST",
        path: "/api/project-files/finalize",
      });
      return mirroredObjectId;
    } catch (error) {
      if (mirroredObjectId) {
        return mirroredObjectId;
      }
      return this.uploadBinaryViaServerRoute({
        bytes,
        contentType,
        fileId,
        fileName,
        projectId,
      });
    }
  }

  async uploadSupabaseMirror({ bytes, contentType, fileId }) {
    const session = await this.getSession();
    const storage = requiredRecord(
      session,
      "storage",
      "Prism session missing storage config",
    );
    const supabaseUrl = requiredString(
      storage,
      "supabaseUrl",
      "Prism session missing Supabase URL",
    );
    const anonKey = requiredString(
      storage,
      "supabaseAnonKey",
      "Prism session missing Supabase anon key",
    );
    const bucket = requiredString(
      storage,
      "projectFilesBucket",
      "Prism session missing project-files bucket",
    );
    const response = await fetchWithTimeout(
      `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/${encodeURIComponent(
        bucket,
      )}/${encodeURIComponent(fileId)}`,
      {
        body: bytes,
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${session.accessToken}`,
          "cache-control": "max-age=3600",
          "content-type": contentType,
          "x-upsert": "false",
        },
        method: "POST",
      },
    );
    const body = await response.text();
    if (!response.ok) {
      throw new PrismMcpBackendError(
        `Prism Supabase mirror upload failed with status ${response.status}: ${body}`,
      );
    }
    const payload = parseJsonRecord(body, "Prism Supabase mirror upload");
    return requiredString(
      payload,
      "Id",
      "Prism Supabase mirror upload response missing Id",
    );
  }

  async uploadToSignedUrl({ bytes, contentType, uploadUrl }) {
    const response = await fetchWithTimeout(uploadUrl, {
      body: bytes,
      headers: {
        "content-type": contentType,
        "x-ms-blob-type": "BlockBlob",
      },
      method: "PUT",
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new PrismMcpBackendError(
        `Prism signed Sediment upload failed with status ${response.status}: ${detail}`,
      );
    }
  }

  async downloadBinaryFile(fileId, outputPath) {
    const response = await this.fetchRaw({
      context: "Prism binary download",
      method: "GET",
      path: `/api/project-files/content/${encodeURIComponent(fileId)}`,
    });
    if (!response.body) {
      throw new PrismMcpBackendError("Prism binary download returned no body");
    }
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const bytes = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(outputPath, bytes);
    return bytes.length;
  }

  async fetchJson({ body, context, method, path: requestPath }) {
    const response = await this.fetchRaw({
      body,
      context,
      method,
      path: requestPath,
    });
    const responseBody = await response.text();
    return parseJsonRecord(responseBody, context);
  }

  async fetchRaw({ body, context, method, path: requestPath }) {
    const session = await this.getSession();
    const headers = {
      Authorization: `Bearer ${session.accessToken}`,
    };
    if (body !== undefined && !(body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
    }
    const response = await fetchWithTimeout(`${this.baseUrl}${requestPath}`, {
      body:
        body === undefined || body instanceof FormData
          ? body
          : JSON.stringify(body),
      headers,
      method,
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new PrismMcpBackendError(
        `${context} failed with status ${response.status}: ${detail}`,
      );
    }
    return response;
  }

  async getSession() {
    if (
      this.cachedSession &&
      this.cachedSession.expiresAtMs - SESSION_REFRESH_SKEW_MS > Date.now()
    ) {
      return this.cachedSession;
    }

    const auth = await loadCodexAuth(this.authPath);
    const response = await fetchWithTimeout(
      `${this.baseUrl}/api/auth/codex-session`,
      {
        body: "{}",
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    );
    const body = await response.text();
    if (!response.ok) {
      throw new PrismMcpAuthError(
        `Prism session exchange failed with status ${response.status}: ${body}`,
      );
    }
    const payload = parseJsonRecord(body, "Prism session exchange");
    const session = requiredRecord(
      payload,
      "session",
      "Prism session exchange response missing session",
    );
    const accessToken = requiredString(
      session,
      "access_token",
      "Prism session exchange response missing access token",
    );
    const expiresAtSeconds =
      positiveNumber(session.expires_at) ??
      Math.floor(Date.now() / 1000) +
        (positiveNumber(session.expires_in) ?? 60 * 60);
    const storage = requiredRecord(
      payload,
      "storage",
      "Prism session exchange response missing storage config",
    );
    this.cachedSession = {
      accessToken,
      expiresAtMs: expiresAtSeconds * 1000,
      storage: {
        projectFilesBucket: requiredString(
          storage,
          "project_files_bucket",
          "Prism session exchange response missing project-files bucket",
        ),
        supabaseAnonKey: requiredString(
          storage,
          "supabase_anon_key",
          "Prism session exchange response missing Supabase anon key",
        ),
        supabaseUrl: requiredString(
          storage,
          "supabase_url",
          "Prism session exchange response missing Supabase URL",
        ),
      },
    };
    return this.cachedSession;
  }
}

function parseArgs(argv) {
  const config = {
    authPath: defaultAuthPath(),
    prismBaseUrl: process.env.PRISM_BASE_URL?.trim() || DEFAULT_PRISM_BASE_URL,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--transport") {
      index += 1;
      if (next !== "stdio") {
        throw new Error("Only --transport stdio is supported");
      }
    } else if (arg === "--auth-path" && next != null) {
      config.authPath = next;
      index += 1;
    } else if (arg === "--prism-base-url" && next != null) {
      config.prismBaseUrl = next;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelpAndExit();
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  return config;
}

async function handleRequest(config, request) {
  switch (request.method) {
    case "initialize":
      return {
        capabilities: { tools: {} },
        protocolVersion:
          isRecord(request.params) &&
          typeof request.params.protocolVersion === "string"
            ? request.params.protocolVersion
            : "2025-06-18",
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
      };
    case "tools/list":
      return { tools: toolDefinitions() };
    case "tools/call":
      return callTool(config, request.params);
    case "prompts/list":
      return { prompts: [] };
    case "resources/list":
      return { resources: [] };
    case "ping":
      return {};
    default:
      throw jsonRpcError(-32601, `Method not found: ${request.method ?? ""}`);
  }
}

async function callTool(config, params) {
  if (!isRecord(params) || typeof params.name !== "string") {
    throw jsonRpcError(-32602, "Invalid tools/call params");
  }
  const args = isRecord(params.arguments) ? params.arguments : {};
  const backend = (config.backend ??= new PrismBackend(config));
  let result;
  if (params.name === "list_projects") {
    result = await backend.listProjects({
      limit: optionalPositiveInteger(args.limit, "limit"),
      query: optionalArg(args, "query"),
    });
  } else if (params.name === "get_project") {
    result = await backend.getProject(requiredArg(args, "project_id"));
  } else if (params.name === "list_files") {
    result = await backend.listFiles(requiredArg(args, "project_id"));
  } else if (params.name === "read_file") {
    result = await readFileTool(backend, args);
  } else if (params.name === "download_file") {
    result = await downloadFileTool(backend, args);
  } else if (params.name === "write_file") {
    result = await writeFileTool(backend, args);
  } else if (params.name === "upload_file") {
    result = await uploadFileTool(backend, args);
  } else if (params.name === "create_file") {
    result = await createFileTool(backend, args);
  } else if (params.name === "sync_status") {
    result = await syncStatusTool(backend, args);
  } else if (params.name === "sync_pull") {
    result = await syncPullTool(backend, args);
  } else if (params.name === "sync_push") {
    result = await syncPushTool(backend, args);
  } else {
    throw jsonRpcError(-32602, `Unknown tool: ${params.name}`);
  }
  return toolResult(result);
}

async function readFileTool(backend, args) {
  const projectId = requiredArg(args, "project_id");
  const filePath = requiredArg(args, "path");
  const payload = await backend.readFile(projectId, filePath);
  const file = requiredRecord(
    payload,
    "file",
    "Prism file response missing file",
  );
  if (file.kind !== "text") {
    throw new PrismMcpBackendError(
      "read_file only supports text files; use download_file for binary files",
    );
  }
  return {
    project_id: projectId,
    file: file.entry,
    text: typeof file.text === "string" ? file.text : "",
  };
}

async function downloadFileTool(backend, args) {
  const projectId = requiredArg(args, "project_id");
  const filePath = normalizeProjectPath(requiredArg(args, "path"));
  const payload = await backend.readFile(projectId, filePath);
  const file = requiredRecord(
    payload,
    "file",
    "Prism file response missing file",
  );
  const entry = requiredRecord(
    file,
    "entry",
    "Prism file response missing entry",
  );
  const outputPath = await resolveDownloadPath({
    outputPath: optionalArg(args, "output_path"),
    projectId,
    filePath,
  });

  if (file.kind === "text") {
    const text = typeof file.text === "string" ? file.text : "";
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, text, "utf8");
    return {
      project_id: projectId,
      file: entry,
      local_path: outputPath,
      size_bytes: Buffer.byteLength(text),
    };
  }
  if (file.kind !== "binary") {
    throw new PrismMcpBackendError("Prism file response had unknown kind");
  }
  const sizeBytes = await backend.downloadBinaryFile(
    requiredString(entry, "id", "Prism binary file missing id"),
    outputPath,
  );
  return {
    project_id: projectId,
    file: entry,
    local_path: outputPath,
    size_bytes: sizeBytes,
  };
}

async function uploadFileTool(backend, args) {
  const projectId = requiredArg(args, "project_id");
  const localPath = requiredAbsolutePath(args, "local_path");
  const remotePath = normalizeProjectPath(
    optionalArg(args, "path") ?? path.basename(localPath),
  );
  const payload = await backend.uploadBinaryFile(
    projectId,
    localPath,
    remotePath,
  );
  return {
    project_id: projectId,
    file: payload.file,
    local_path: localPath,
  };
}

async function writeFileTool(backend, args) {
  const projectId = requiredArg(args, "project_id");
  const filePath = normalizeProjectPath(requiredArg(args, "path"));
  const payload = await backend.writeTextFile(
    projectId,
    filePath,
    requiredArg(args, "text"),
  );
  return {
    project_id: projectId,
    file: payload.file,
  };
}

async function createFileTool(backend, args) {
  const projectId = requiredArg(args, "project_id");
  const filePath = normalizeProjectPath(requiredArg(args, "path"));
  const payload = await backend.createTextFile(
    projectId,
    filePath,
    typeof args.text === "string" ? args.text : "",
  );
  return {
    project_id: projectId,
    file: payload.file,
  };
}

async function syncStatusTool(backend, args) {
  const folderPath = requiredAbsolutePath(args, "folder_path");
  const manifest = await readSyncManifest(folderPath);
  const projectId = optionalArg(args, "project_id") ?? manifest?.project_id;
  if (!projectId) {
    throw new PrismMcpBackendError(
      "project_id is required when the folder has no Prism sync manifest",
    );
  }
  const plan = await buildSyncPlan({
    backend,
    folderPath,
    manifest,
    projectId,
  });
  return summarizeSyncPlan(plan);
}

async function syncPullTool(backend, args) {
  const folderPath = requiredAbsolutePath(args, "folder_path");
  const manifest = await readSyncManifest(folderPath);
  const projectId = optionalArg(args, "project_id") ?? manifest?.project_id;
  if (!projectId) {
    throw new PrismMcpBackendError(
      "project_id is required when the folder has no Prism sync manifest",
    );
  }
  const plan = await buildSyncPlan({
    backend,
    folderPath,
    manifest,
    projectId,
  });
  const pulled = [];
  for (const action of plan.actions) {
    if (action.status !== "remote_only" && action.status !== "remote_changed") {
      continue;
    }
    const localPath = resolveFolderChild(folderPath, action.path);
    await downloadRemoteFileToPath(
      backend,
      projectId,
      action.remote,
      localPath,
    );
    pulled.push(action.path);
  }
  const refreshed = await buildSyncPlan({
    backend,
    folderPath,
    manifest: await readSyncManifest(folderPath),
    projectId,
  });
  await writeSyncManifest(folderPath, {
    projectId,
    previous: manifest,
    plan: refreshed,
    additionalSyncedPaths: pulled,
  });
  const finalPlan = await buildSyncPlan({
    backend,
    folderPath,
    manifest: await readSyncManifest(folderPath),
    projectId,
  });
  return {
    ...summarizeSyncPlan(finalPlan),
    pulled,
  };
}

async function syncPushTool(backend, args) {
  const folderPath = requiredAbsolutePath(args, "folder_path");
  const manifest = await readSyncManifest(folderPath);
  const projectId = optionalArg(args, "project_id") ?? manifest?.project_id;
  if (!projectId) {
    throw new PrismMcpBackendError(
      "project_id is required when the folder has no Prism sync manifest",
    );
  }
  const plan = await buildSyncPlan({
    backend,
    folderPath,
    manifest,
    projectId,
  });
  const pushed = [];
  for (const action of plan.actions) {
    if (action.status !== "local_only" && action.status !== "local_changed") {
      continue;
    }
    const localPath = resolveFolderChild(folderPath, action.path);
    await uploadLocalFile(backend, projectId, localPath, action.path);
    pushed.push(action.path);
  }
  const refreshed = await buildSyncPlan({
    backend,
    folderPath,
    manifest: await readSyncManifest(folderPath),
    projectId,
  });
  await writeSyncManifest(folderPath, {
    projectId,
    previous: manifest,
    plan: refreshed,
    additionalSyncedPaths: pushed,
  });
  const finalPlan = await buildSyncPlan({
    backend,
    folderPath,
    manifest: await readSyncManifest(folderPath),
    projectId,
  });
  return {
    ...summarizeSyncPlan(finalPlan),
    pushed,
  };
}

async function buildSyncPlan({ backend, folderPath, manifest, projectId }) {
  const [remotePayload, localFiles] = await Promise.all([
    backend.listFiles(projectId),
    scanLocalFiles(folderPath),
  ]);
  const remoteFiles = new Map(
    Array.isArray(remotePayload.files)
      ? remotePayload.files.map((file) => [file.path, file])
      : [],
  );
  const paths = new Set([...remoteFiles.keys(), ...localFiles.keys()]);
  const actions = [...paths].sort().map((filePath) =>
    classifySyncPath({
      baseline: manifest?.files?.[filePath],
      local: localFiles.get(filePath),
      path: filePath,
      remote: remoteFiles.get(filePath),
    }),
  );
  return { actions, localFiles, manifest, projectId, remoteFiles };
}

function classifySyncPath({ baseline, local, path: filePath, remote }) {
  if (local && !remote) {
    return { path: filePath, local, remote: null, status: "local_only" };
  }
  if (!local && remote) {
    return { path: filePath, local: null, remote, status: "remote_only" };
  }
  if (!local || !remote) {
    return { path: filePath, local: null, remote: null, status: "in_sync" };
  }

  if (!baseline) {
    if (remote.sha256 && remote.sha256 === local.sha256) {
      return { path: filePath, local, remote, status: "in_sync" };
    }
    return { path: filePath, local, remote, status: "both_changed" };
  }

  const localChanged = baseline.local_sha256 !== local.sha256;
  const remoteChanged = baseline.remote_version !== remote.remote_version;
  if (localChanged && remoteChanged) {
    return { path: filePath, local, remote, status: "both_changed" };
  }
  if (localChanged) {
    return { path: filePath, local, remote, status: "local_changed" };
  }
  if (remoteChanged) {
    return { path: filePath, local, remote, status: "remote_changed" };
  }
  return { path: filePath, local, remote, status: "in_sync" };
}

function summarizeSyncPlan(plan) {
  const byStatus = {
    in_sync: [],
    local_only: [],
    remote_only: [],
    local_changed: [],
    remote_changed: [],
    both_changed: [],
  };
  for (const action of plan.actions) {
    byStatus[action.status].push(action.path);
  }
  return {
    project_id: plan.projectId,
    in_sync: byStatus.in_sync,
    local_only: byStatus.local_only,
    remote_only: byStatus.remote_only,
    local_changed: byStatus.local_changed,
    remote_changed: byStatus.remote_changed,
    conflicts: byStatus.both_changed,
  };
}

async function downloadRemoteFileToPath(backend, projectId, remote, localPath) {
  if (!remote) {
    throw new PrismMcpBackendError("Missing remote file metadata");
  }
  const payload = await backend.readFile(projectId, remote.path);
  const file = requiredRecord(
    payload,
    "file",
    "Prism file response missing file",
  );
  if (file.kind === "text") {
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(
      localPath,
      typeof file.text === "string" ? file.text : "",
      "utf8",
    );
    return;
  }
  await backend.downloadBinaryFile(remote.id, localPath);
}

async function uploadLocalFile(backend, projectId, localPath, remotePath) {
  const bytes = await fs.readFile(localPath);
  if (isTextFile(remotePath, bytes)) {
    await backend.writeTextFile(projectId, remotePath, bytes.toString("utf8"));
  } else {
    await backend.uploadBinaryFile(projectId, localPath, remotePath);
  }
}

async function scanLocalFiles(folderPath) {
  const result = new Map();
  await walk(folderPath, "");
  return result;

  async function walk(directory, relativePrefix) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (DEFAULT_SYNC_IGNORED_NAMES.has(entry.name)) {
        continue;
      }
      const relativePath = relativePrefix
        ? `${relativePrefix}/${entry.name}`
        : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        const bytes = await fs.readFile(absolutePath);
        result.set(relativePath, {
          path: relativePath,
          local_path: absolutePath,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  }
}

async function readSyncManifest(folderPath) {
  try {
    const raw = await fs.readFile(
      path.join(folderPath, DEFAULT_SYNC_MANIFEST_NAME),
      "utf8",
    );
    const parsed = JSON.parse(raw);
    return isRecord(parsed) &&
      parsed.version === SYNC_MANIFEST_VERSION &&
      typeof parsed.project_id === "string" &&
      isRecord(parsed.files)
      ? parsed
      : null;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeSyncManifest(
  folderPath,
  { projectId, previous, plan, additionalSyncedPaths },
) {
  const nextFiles = { ...(previous?.files ?? {}) };
  const explicitlySynced = new Set(additionalSyncedPaths);
  for (const action of plan.actions) {
    if (!action.local || !action.remote) {
      continue;
    }
    const safeToRecord =
      action.status === "in_sync" || explicitlySynced.has(action.path);
    if (!safeToRecord) {
      continue;
    }
    nextFiles[action.path] = {
      kind: action.remote.kind,
      local_sha256: action.local.sha256,
      remote_version: action.remote.remote_version,
    };
  }
  await fs.mkdir(folderPath, { recursive: true });
  await fs.writeFile(
    path.join(folderPath, DEFAULT_SYNC_MANIFEST_NAME),
    `${JSON.stringify(
      {
        version: SYNC_MANIFEST_VERSION,
        project_id: projectId,
        files: nextFiles,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function toolDefinitions() {
  return [
    tool("list_projects", "List Prism projects visible to the current user", {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    }),
    tool("get_project", "Get one Prism project", projectIdSchema()),
    tool("list_files", "List files in a Prism project", projectIdSchema()),
    tool("read_file", "Read one text file from a Prism project", {
      type: "object",
      required: ["project_id", "path"],
      properties: {
        project_id: { type: "string" },
        path: { type: "string" },
      },
      additionalProperties: false,
    }),
    tool("download_file", "Download one Prism project file locally", {
      type: "object",
      required: ["project_id", "path"],
      properties: {
        project_id: { type: "string" },
        path: { type: "string" },
        output_path: { type: "string" },
      },
      additionalProperties: false,
    }),
    tool("write_file", "Write one generated text file in a Prism project", {
      type: "object",
      required: ["project_id", "path", "text"],
      properties: {
        project_id: { type: "string" },
        path: { type: "string" },
        text: { type: "string" },
      },
      additionalProperties: false,
    }),
    tool("upload_file", "Upload one external local file into a Prism project", {
      type: "object",
      required: ["project_id", "local_path"],
      properties: {
        project_id: { type: "string" },
        local_path: { type: "string" },
        path: { type: "string" },
      },
      additionalProperties: false,
    }),
    tool("create_file", "Create one new text file in a Prism project", {
      type: "object",
      required: ["project_id", "path"],
      properties: {
        project_id: { type: "string" },
        path: { type: "string" },
        text: { type: "string" },
      },
      additionalProperties: false,
    }),
    tool(
      "sync_status",
      "Compare a local folder with a Prism project",
      syncSchema(),
    ),
    tool(
      "sync_pull",
      "Pull safe remote changes into a local folder",
      syncSchema(),
    ),
    tool(
      "sync_push",
      "Push safe local changes into a Prism project",
      syncSchema(),
    ),
  ];
}

function tool(name, description, inputSchema) {
  return { name, description, inputSchema };
}

function projectIdSchema() {
  return {
    type: "object",
    required: ["project_id"],
    properties: {
      project_id: { type: "string" },
    },
    additionalProperties: false,
  };
}

function syncSchema() {
  return {
    type: "object",
    required: ["folder_path"],
    properties: {
      folder_path: { type: "string" },
      project_id: { type: "string" },
    },
    additionalProperties: false,
  };
}

class StdioJsonRpcServer {
  constructor(config) {
    this.config = config;
    this.buffer = "";
  }

  start() {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      this.buffer += chunk;
      while (true) {
        const newlineIndex = this.buffer.indexOf("\n");
        if (newlineIndex < 0) {
          break;
        }
        const line = this.buffer.slice(0, newlineIndex).trim();
        this.buffer = this.buffer.slice(newlineIndex + 1);
        if (line) {
          void this.handleLine(line);
        }
      }
    });
  }

  async handleLine(line) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(request) || request.jsonrpc !== "2.0") {
      return;
    }
    if (request.id === undefined) {
      return;
    }
    try {
      const result = await handleRequest(this.config, request);
      this.write({ id: request.id, jsonrpc: "2.0", result });
    } catch (error) {
      const rpcError = isJsonRpcError(error)
        ? error
        : jsonRpcError(-32603, errorMessage(error));
      this.write({
        error: { code: rpcError.code, message: rpcError.message },
        id: request.id,
        jsonrpc: "2.0",
      });
    }
  }

  write(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

function toolResult(result) {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}

function defaultAuthPath() {
  const codexHome = process.env.CODEX_HOME?.trim();
  return path.join(codexHome || path.join(os.homedir(), ".codex"), "auth.json");
}

async function loadCodexAuth(authPath) {
  const hint =
    "Run `codex login` or pass `--auth-path` to a valid Codex auth.json.";
  let payload;
  try {
    payload = JSON.parse(await fs.readFile(authPath, "utf8"));
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") {
      throw new PrismMcpAuthError(
        `Codex auth not found at ${authPath}. ${hint}`,
      );
    }
    if (error instanceof SyntaxError) {
      throw new PrismMcpAuthError(
        `Invalid Codex auth file at ${authPath}. ${hint}`,
      );
    }
    throw new PrismMcpAuthError(`Unable to read Codex auth at ${authPath}.`);
  }
  if (!isRecord(payload) || !isRecord(payload.tokens)) {
    throw new PrismMcpAuthError(
      `Invalid Codex auth file at ${authPath}. ${hint}`,
    );
  }
  const accessToken = nonEmptyString(payload.tokens.access_token);
  if (!accessToken) {
    throw new PrismMcpAuthError(`Codex auth missing access token. ${hint}`);
  }
  return { accessToken };
}

async function resolveDownloadPath({ outputPath, projectId, filePath }) {
  if (outputPath) {
    if (!path.isAbsolute(outputPath)) {
      throw new PrismMcpBackendError("output_path must be absolute");
    }
    return outputPath;
  }
  return path.join(os.tmpdir(), "prism-downloads", projectId, filePath);
}

function resolveFolderChild(folderPath, relativePath) {
  const resolvedRoot = path.resolve(folderPath);
  const resolvedChild = path.resolve(resolvedRoot, relativePath);
  if (
    resolvedChild !== resolvedRoot &&
    !resolvedChild.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new PrismMcpBackendError("Path escapes sync folder");
  }
  return resolvedChild;
}

function normalizeProjectPath(value) {
  const normalized = String(value)
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+/u, "")
    .replace(/\/+/gu, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (
    parts.length === 0 ||
    parts.some((part) => part === "." || part === "..")
  ) {
    throw new PrismMcpBackendError("Invalid project file path");
  }
  return parts.join("/");
}

function isTextFile(filePath, bytes) {
  if (TEXT_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return canDecodeUtf8(bytes);
  }
  return !bytes.includes(0) && canDecodeUtf8(bytes);
}

function canDecodeUtf8(bytes) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function guessMimeType(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".pdf") return "application/pdf";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

async function fetchWithTimeout(input, init) {
  return fetch(input, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function requiredArg(args, key) {
  const value = optionalArg(args, key);
  if (!value) {
    throw new PrismMcpBackendError(`${key} is required`);
  }
  return value;
}

function optionalArg(args, key) {
  return nonEmptyString(args[key]);
}

function requiredAbsolutePath(args, key) {
  const value = requiredArg(args, key);
  if (!path.isAbsolute(value)) {
    throw new PrismMcpBackendError(`${key} must be an absolute path`);
  }
  return value;
}

function parseJsonRecord(body, context) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new PrismMcpBackendError(`${context} returned invalid JSON`);
  }
  if (!isRecord(payload)) {
    throw new PrismMcpBackendError(`${context} returned invalid payload`);
  }
  return payload;
}

function requiredRecord(payload, key, message) {
  const value = payload[key];
  if (!isRecord(value)) {
    throw new PrismMcpBackendError(message);
  }
  return value;
}

function requiredString(payload, key, message) {
  const value = nonEmptyString(payload[key]);
  if (!value) {
    throw new PrismMcpBackendError(message);
  }
  return value;
}

function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function optionalPositiveInteger(value, name) {
  if (value == null) {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(String(value));
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new PrismMcpBackendError(`${name} must be a positive integer`);
  }
  return parsed;
}

function jsonRpcError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isJsonRpcError(error) {
  return error instanceof Error && typeof error.code === "number";
}

function errorMessage(error) {
  if (
    error instanceof PrismMcpAuthError ||
    error instanceof PrismMcpBackendError
  ) {
    return error.message;
  }
  return error instanceof Error && error.message
    ? error.message
    : "Prism operation failed.";
}

function errorCode(error) {
  return isRecord(error) && typeof error.code === "string"
    ? error.code
    : undefined;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function printHelpAndExit() {
  console.error(`Usage: prism_mcp_server [options]

Options:
  --transport stdio
  --auth-path PATH
  --prism-base-url URL`);
  process.exit(0);
}

try {
  new StdioJsonRpcServer(parseArgs(process.argv.slice(2))).start();
} catch (error) {
  console.error(errorMessage(error));
  process.exit(1);
}
