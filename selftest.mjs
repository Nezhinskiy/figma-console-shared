// Smoke test: two concurrent MCP clients against the shared bridge.
// Usage: node selftest.mjs [port]   (default: $FIGMA_SHARED_PORT or 9240)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const port = process.argv[2] || process.env.FIGMA_SHARED_PORT || "9240";
const url = new URL(`http://127.0.0.1:${port}/mcp`);

async function one(name) {
  const c = new Client({ name, version: "0" });
  await c.connect(new StreamableHTTPClientTransport(url));
  const tools = await c.listTools();
  const status = await c.callTool({ name: "figma_get_status", arguments: {} });
  const text = status.content?.find((x) => x.type === "text")?.text ?? "";
  await c.close();
  return { name, tools: tools.tools.length, status: text.slice(0, 400) };
}

const results = await Promise.all([one("a"), one("b")]);
console.log(JSON.stringify(results, null, 1));
