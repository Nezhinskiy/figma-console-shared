# figma-console-shared

Run **one** [figma-console-mcp](https://github.com/southleft/figma-console-mcp) process and share it with any number of MCP clients (Claude Code sessions, editors, agents) over Streamable HTTP on `127.0.0.1`.

> Unofficial companion project. Not affiliated with, endorsed by, or supported by Figma or the figma-console-mcp authors.

## The problem

figma-console-mcp is a stdio MCP server: every MCP client that has it configured starts its own copy. Each copy opens a WebSocket server for the Figma **Desktop Bridge** plugin and takes the first free port in the range **9223–9232**. That range holds ten instances. Open an eleventh session (common when you run many agent sessions in parallel) and it finds no free port, so its Figma tools fail. You also end up with up to ten Node processes and ten WebSocket servers doing the same job.

## How it works

```
 Claude Code session A ─┐
 Claude Code session B ─┼─ HTTP ─▶ bridge.mjs (127.0.0.1:9240/mcp) ─ stdio ─▶ figma-console-mcp ─ ws:9223 ─▶ Figma Desktop Bridge plugin
 any other MCP client  ─┘
```

- `bridge.mjs` starts a single figma-console-mcp child process over stdio and connects to it as an MCP client.
- It serves MCP over Streamable HTTP. Each HTTP session gets its own lightweight MCP server front-end that advertises the upstream server's name, version, capabilities and instructions.
- Every request from any session (`tools/list`, `tools/call`, …) is forwarded to the one upstream process; progress notifications are routed back to the session that asked, and other upstream notifications are broadcast to all sessions.
- Only one Desktop Bridge port is ever used, so the plugin always connects to the right process.
- If the upstream process exits, the bridge exits too and the supervisor (launchd) restarts both.
- It listens on `127.0.0.1` only, with DNS-rebinding protection (only `127.0.0.1:<port>` and `localhost:<port>` are accepted as `Host`). Idle sessions are dropped after 24 hours.

## Requirements

- macOS for the bundled launchd service (the bridge itself is plain Node.js and runs anywhere; use your own supervisor elsewhere).
- Node.js 18 or newer.
- Figma Desktop with the figma-console-mcp **Desktop Bridge** plugin (see the [figma-console-mcp docs](https://github.com/southleft/figma-console-mcp)).
- Optional: a Figma personal access token for the REST-API tools.

## Install

```bash
git clone https://github.com/Nezhinskiy/figma-console-shared.git ~/.local/share/figma-console-shared
cd ~/.local/share/figma-console-shared
npm ci
```

Optionally store a Figma personal access token in a file readable only by you. The bridge refuses to read a token file that group or others can access, and the token never appears in the plist or on a command line.

```bash
(umask 077; printf '%s\n' 'YOUR_FIGMA_TOKEN' > token)
```

Install and start the launchd user agent:

```bash
./install.sh
```

`install.sh` generates `~/Library/LaunchAgents/local.figma-console-shared.plist` from `launchd/figma-console-shared.plist.template`, filling in the folder the script lives in and the absolute path of `node` from `command -v node`. Run `./install.sh --dry-run` to print the generated plist without touching launchd. Re-run `./install.sh` after moving the folder or switching Node versions.

Configuration (environment variables, read by `install.sh` and by `bridge.mjs`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `FIGMA_SHARED_PORT` | `9240` | HTTP port on `127.0.0.1` |
| `FIGMA_SHARED_TOKEN_FILE` | `<install dir>/token` | File with the Figma personal access token (must be mode `600`) |
| `NODE` | `command -v node` | Node binary to run the service with (`install.sh` only) |

For example: `FIGMA_SHARED_PORT=9250 ./install.sh`.

Logs go to `~/Library/Logs/figma-console-shared.log`. Health check:

```bash
curl http://127.0.0.1:9240/health
```

## Connect your MCP clients

Claude Code, once for all projects:

```bash
claude mcp add --transport http figma-console http://127.0.0.1:9240/mcp -s user
```

Remove any stdio `figma-console` entries (user, project or `.mcp.json`) so clients stop starting their own copies. Any other client that supports Streamable HTTP can point at the same URL.

Then open the Desktop Bridge plugin in Figma; it finds the single server on port 9223.

## Self-test

With the service running, open two concurrent MCP sessions, list tools and call `figma_get_status` in each:

```bash
npm run selftest            # port 9240
node selftest.mjs 9250      # another port
```

## Uninstall

```bash
./uninstall.sh
```

This stops the agent and removes the plist. The folder, your token file and the log stay; delete them yourself if you no longer need them. Re-add stdio `figma-console` entries to your clients if you want the old behaviour back.

## Limitations

- **One shared Figma context.** All sessions talk to the same figma-console-mcp process and the same Desktop Bridge connection, so they share one active Figma file, selection and console log buffer. Two sessions working in different Figma files at the same time will step on each other.
- **No authentication.** Any process of any local user that can reach `127.0.0.1:<port>` can use the bridge, and through it your Figma token. Do not expose the port beyond localhost.
- **Restart drops sessions.** When the upstream process or the bridge restarts, clients must reconnect (in Claude Code: `/mcp` → reconnect).
- **macOS only for the installer.** On Linux or Windows run `node bridge.mjs` under systemd, a scheduled task, pm2 or similar.
- Upstream versions are pinned in `package.json`. To upgrade figma-console-mcp, bump the version, run `npm install`, run the self-test, then `./install.sh`.

## Credits

All Figma functionality comes from [figma-console-mcp](https://github.com/southleft/figma-console-mcp) by Southleft and the Figma Console MCP contributors, licensed under MIT. This project only adds the sharing layer and is installed alongside it as an npm dependency; it does not modify or redistribute its code.

Built on the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

## License

[MIT](LICENSE) © 2026 Mikhail Nezhinsky
