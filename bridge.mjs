// Shared figma-console MCP server.
//
// Runs ONE figma-console-mcp process (stdio) and exposes it to any number of
// MCP clients over Streamable HTTP on 127.0.0.1. Every client session gets its
// own lightweight MCP Server front-end; all requests are forwarded to the single
// upstream client, and upstream notifications are broadcast to every session.
//
// Configuration (environment variables):
//   FIGMA_SHARED_PORT        HTTP port on 127.0.0.1 (default 9240)
//   FIGMA_SHARED_TOKEN_FILE  file holding the Figma personal access token
//                            (default: ./token next to this script). It must be
//                            readable by the owner only (chmod 600); the token is
//                            never passed on the command line or in the plist.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ResultSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST = "127.0.0.1";
const PORT = Number(process.env.FIGMA_SHARED_PORT || 9240);
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;

const log = (...a) => console.error(new Date().toISOString(), "[bridge]", ...a);

const TOKEN_FILE = process.env.FIGMA_SHARED_TOKEN_FILE || path.join(HERE, "token");

function readToken() {
  let stat;
  try {
    stat = fs.statSync(TOKEN_FILE);
  } catch {
    log(`no token file at ${TOKEN_FILE}; REST-API tools will not work`);
    return undefined;
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    log(`refusing to read ${TOKEN_FILE}: it is accessible by group/others (run: chmod 600 "${TOKEN_FILE}")`);
    return undefined;
  }
  const value = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  return value || undefined;
}

// ---- upstream: the one and only figma-console-mcp process ------------------

const upstream = new Client({ name: "figma-console-shared-bridge", version: "1.0.0" }, { capabilities: {} });
const token = readToken();
const upstreamTransport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(HERE, "node_modules/figma-console-mcp/dist/local.js")],
  env: { ...process.env, ...(token ? { FIGMA_ACCESS_TOKEN: token } : {}) },
  stderr: "inherit",
});

let shuttingDown = false;
upstream.onclose = () => {
  if (shuttingDown) return;
  log("upstream figma-console-mcp exited; exiting so the supervisor restarts us");
  process.exit(1);
};

const sessions = new Map(); // sessionId -> { server, transport, lastSeen }

upstream.fallbackNotificationHandler = async (notification) => {
  for (const { server } of sessions.values()) {
    server.notification(notification).catch(() => {});
  }
};

await upstream.connect(upstreamTransport);
const upstreamInfo = upstream.getServerVersion() ?? { name: "figma-console-mcp", version: "unknown" };
const upstreamCaps = upstream.getServerCapabilities() ?? {};
const upstreamInstructions = upstream.getInstructions();
log(`upstream connected: ${upstreamInfo.name}@${upstreamInfo.version}`);

// ---- downstream: one front-end Server per HTTP session ---------------------

function makeFrontend() {
  const server = new Server(upstreamInfo, {
    capabilities: upstreamCaps,
    ...(upstreamInstructions ? { instructions: upstreamInstructions } : {}),
  });

  server.fallbackRequestHandler = async (request, extra) => {
    const downstreamToken = request.params?._meta?.progressToken;
    const params = request.params ? { ...request.params } : undefined;
    if (params?._meta) {
      const { progressToken, ...restMeta } = params._meta;
      params._meta = Object.keys(restMeta).length ? restMeta : undefined;
      if (!params._meta) delete params._meta;
    }
    return upstream.request({ method: request.method, ...(params ? { params } : {}) }, ResultSchema, {
      signal: extra.signal,
      timeout: REQUEST_TIMEOUT_MS,
      resetTimeoutOnProgress: true,
      ...(downstreamToken !== undefined
        ? {
            onprogress: (p) =>
              extra
                .sendNotification({
                  method: "notifications/progress",
                  params: { ...p, progressToken: downstreamToken },
                })
                .catch(() => {}),
          }
        : {}),
    });
  };
  return server;
}

const allowedHosts = [`${HOST}:${PORT}`, `localhost:${PORT}`];

async function handle(req, res) {
  if (!req.url?.startsWith("/mcp")) {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, upstream: upstreamInfo, sessions: sessions.size }));
      return;
    }
    res.writeHead(404).end();
    return;
  }

  const sid = req.headers["mcp-session-id"];
  if (typeof sid === "string" && sessions.has(sid)) {
    const s = sessions.get(sid);
    s.lastSeen = Date.now();
    await s.transport.handleRequest(req, res);
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(sid ? 404 : 400, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Unknown or missing session" }, id: null }));
    return;
  }

  // New session: must start with initialize.
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (!isInitializeRequest(body)) {
    res.writeHead(sid ? 404 : 400, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Unknown or missing session" }, id: body?.id ?? null }));
    return;
  }

  const server = makeFrontend();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableDnsRebindingProtection: true,
    allowedHosts,
    onsessioninitialized: (id) => {
      sessions.set(id, { server, transport, lastSeen: Date.now() });
      log(`session opened ${id} (${sessions.size} active)`);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId && sessions.delete(transport.sessionId)) {
      log(`session closed ${transport.sessionId} (${sessions.size} active)`);
    }
  };
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

// Drop sessions whose client vanished without a DELETE.
setInterval(() => {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [id, s] of sessions) {
    if (s.lastSeen < cutoff) {
      sessions.delete(id);
      s.transport.close().catch(() => {});
      log(`session expired ${id}`);
    }
  }
}, 60 * 60 * 1000).unref();

const httpServer = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    log("request error:", err?.stack || err);
    if (!res.headersSent) res.writeHead(500).end();
  });
});
httpServer.listen(PORT, HOST, () => log(`listening on http://${HOST}:${PORT}/mcp`));

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    shuttingDown = true;
    log(`${sig}: shutting down`);
    httpServer.close();
    await upstream.close().catch(() => {});
    process.exit(0);
  });
}
