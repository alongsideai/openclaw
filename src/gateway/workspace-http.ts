import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { authorizeGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import {
  readJsonBodyOrError,
  sendInvalidRequest,
  sendJson,
  sendUnauthorized,
} from "./http-common.js";
import { getBearerToken } from "./http-utils.js";

const MAX_FILE_READ_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_TREE_ENTRIES = 5000;
const MAX_TREE_DEPTH = 10;
const SKIP_DIRS = new Set([".git", "node_modules", ".cache", "__pycache__"]);

type TreeNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  modifiedMs?: number;
  children?: TreeNode[];
};

function resolveSafePath(workspaceDir: string, relativePath: string): string | null {
  const resolved = path.resolve(workspaceDir, relativePath);
  if (!resolved.startsWith(workspaceDir + path.sep) && resolved !== workspaceDir) return null;
  return resolved;
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const check = buffer.subarray(0, 8192);
  for (let i = 0; i < check.length; i++) {
    if (check[i] === 0) return true;
  }
  return false;
}

const MIME_MAP: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
};

async function buildTree(
  dir: string,
  basePath: string,
  depth: number,
  counter: { count: number },
): Promise<TreeNode[]> {
  if (depth > MAX_TREE_DEPTH || counter.count >= MAX_TREE_ENTRIES) return [];

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const dirs: TreeNode[] = [];
  const files: TreeNode[] = [];

  for (const entry of entries) {
    if (counter.count >= MAX_TREE_ENTRIES) break;

    if (SKIP_DIRS.has(entry.name) && entry.isDirectory()) continue;

    const relPath = basePath ? `${basePath}/${entry.name}` : entry.name;
    counter.count++;

    if (entry.isDirectory()) {
      const children = await buildTree(path.join(dir, entry.name), relPath, depth + 1, counter);
      dirs.push({ name: entry.name, path: relPath, type: "directory", children });
    } else if (entry.isFile()) {
      try {
        const stat = await fs.stat(path.join(dir, entry.name));
        files.push({
          name: entry.name,
          path: relPath,
          type: "file",
          size: stat.size,
          modifiedMs: stat.mtimeMs,
        });
      } catch {
        files.push({ name: entry.name, path: relPath, type: "file" });
      }
    }
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return [...dirs, ...files];
}

export async function handleWorkspaceHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { auth: ResolvedGatewayAuth; trustedProxies?: string[] },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (!url.pathname.startsWith("/v1/workspace/")) return false;

  const cfg = loadConfig();
  const token = getBearerToken(req);
  const authResult = await authorizeGatewayConnect({
    auth: opts.auth,
    connectAuth: token ? { token, password: token } : null,
    req,
    trustedProxies: opts.trustedProxies ?? cfg.gateway?.trustedProxies,
  });
  if (!authResult.ok) {
    sendUnauthorized(res);
    return true;
  }

  const agentId = url.searchParams.get("agentId") || "main";
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);

  const route = url.pathname.slice("/v1/workspace/".length);

  if (route === "tree" && req.method === "GET") {
    return handleTree(res, workspaceDir);
  }
  if (route === "file" && req.method === "GET") {
    const relPath = url.searchParams.get("path");
    if (!relPath) {
      sendInvalidRequest(res, "Missing path parameter");
      return true;
    }
    return handleFileRead(res, workspaceDir, relPath);
  }
  if (route === "file" && req.method === "PUT") {
    const relPath = url.searchParams.get("path");
    if (!relPath) {
      sendInvalidRequest(res, "Missing path parameter");
      return true;
    }
    return handleFileWrite(req, res, workspaceDir, relPath);
  }
  if (route === "mkdir" && req.method === "POST") {
    const relPath = url.searchParams.get("path");
    if (!relPath) {
      sendInvalidRequest(res, "Missing path parameter");
      return true;
    }
    return handleMkdir(res, workspaceDir, relPath);
  }
  if (route === "file" && req.method === "DELETE") {
    const relPath = url.searchParams.get("path");
    if (!relPath) {
      sendInvalidRequest(res, "Missing path parameter");
      return true;
    }
    return handleDelete(res, workspaceDir, relPath);
  }
  if (route === "download" && req.method === "GET") {
    const relPath = url.searchParams.get("path");
    if (!relPath) {
      sendInvalidRequest(res, "Missing path parameter");
      return true;
    }
    return handleDownload(res, workspaceDir, relPath);
  }

  sendJson(res, 404, { error: { message: "Not found", type: "not_found" } });
  return true;
}

async function handleTree(res: ServerResponse, workspaceDir: string): Promise<true> {
  try {
    await fs.access(workspaceDir);
  } catch {
    sendJson(res, 200, { tree: [] });
    return true;
  }
  const counter = { count: 0 };
  const tree = await buildTree(workspaceDir, "", 0, counter);
  sendJson(res, 200, { tree, truncated: counter.count >= MAX_TREE_ENTRIES });
  return true;
}

async function handleFileRead(
  res: ServerResponse,
  workspaceDir: string,
  relPath: string,
): Promise<true> {
  const safePath = resolveSafePath(workspaceDir, relPath);
  if (!safePath) {
    sendJson(res, 403, { error: { message: "Path traversal denied", type: "forbidden" } });
    return true;
  }

  let stat;
  try {
    stat = await fs.stat(safePath);
  } catch {
    sendJson(res, 404, { error: { message: "File not found", type: "not_found" } });
    return true;
  }

  if (!stat.isFile()) {
    sendInvalidRequest(res, "Not a file");
    return true;
  }

  if (stat.size > MAX_FILE_READ_BYTES) {
    sendJson(res, 413, {
      error: { message: "File too large (max 10MB)", type: "payload_too_large" },
    });
    return true;
  }

  const buffer = await fs.readFile(safePath);
  if (isBinaryBuffer(buffer)) {
    sendJson(res, 200, {
      path: relPath,
      binary: true,
      size: stat.size,
      modifiedMs: stat.mtimeMs,
    });
    return true;
  }

  sendJson(res, 200, {
    path: relPath,
    content: buffer.toString("utf-8"),
    size: stat.size,
    modifiedMs: stat.mtimeMs,
    binary: false,
  });
  return true;
}

async function handleFileWrite(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
  relPath: string,
): Promise<true> {
  const safePath = resolveSafePath(workspaceDir, relPath);
  if (!safePath) {
    sendJson(res, 403, { error: { message: "Path traversal denied", type: "forbidden" } });
    return true;
  }

  const body = await readJsonBodyOrError(req, res, MAX_FILE_READ_BYTES);
  if (body === undefined) return true;

  const { content } = body as { content?: string };
  if (typeof content !== "string") {
    sendInvalidRequest(res, "Missing content field");
    return true;
  }

  await fs.mkdir(path.dirname(safePath), { recursive: true });
  await fs.writeFile(safePath, content, "utf-8");

  const stat = await fs.stat(safePath);
  sendJson(res, 200, { ok: true, size: stat.size, modifiedMs: stat.mtimeMs });
  return true;
}

async function handleMkdir(
  res: ServerResponse,
  workspaceDir: string,
  relPath: string,
): Promise<true> {
  const safePath = resolveSafePath(workspaceDir, relPath);
  if (!safePath) {
    sendJson(res, 403, { error: { message: "Path traversal denied", type: "forbidden" } });
    return true;
  }

  await fs.mkdir(safePath, { recursive: true });
  sendJson(res, 200, { ok: true });
  return true;
}

async function handleDelete(
  res: ServerResponse,
  workspaceDir: string,
  relPath: string,
): Promise<true> {
  const safePath = resolveSafePath(workspaceDir, relPath);
  if (!safePath) {
    sendJson(res, 403, { error: { message: "Path traversal denied", type: "forbidden" } });
    return true;
  }

  try {
    const stat = await fs.stat(safePath);
    if (stat.isDirectory()) {
      await fs.rm(safePath, { recursive: true });
    } else {
      await fs.unlink(safePath);
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      sendJson(res, 404, { error: { message: "File not found", type: "not_found" } });
      return true;
    }
    throw err;
  }

  sendJson(res, 200, { ok: true });
  return true;
}

async function handleDownload(
  res: ServerResponse,
  workspaceDir: string,
  relPath: string,
): Promise<true> {
  const safePath = resolveSafePath(workspaceDir, relPath);
  if (!safePath) {
    sendJson(res, 403, { error: { message: "Path traversal denied", type: "forbidden" } });
    return true;
  }

  let stat;
  try {
    stat = await fs.stat(safePath);
  } catch {
    sendJson(res, 404, { error: { message: "File not found", type: "not_found" } });
    return true;
  }

  if (!stat.isFile()) {
    sendInvalidRequest(res, "Not a file");
    return true;
  }

  const basename = path.basename(safePath);
  const ext = path.extname(safePath).toLowerCase();
  const mime = MIME_MAP[ext] || "application/octet-stream";

  res.statusCode = 200;
  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Disposition", `attachment; filename="${basename}"`);
  res.setHeader("Content-Length", stat.size);

  const stream = createReadStream(safePath);
  stream.pipe(res);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.statusCode = 500;
    }
    res.end();
  });

  return true;
}
