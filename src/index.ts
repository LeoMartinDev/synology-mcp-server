#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createClientFromEnv } from "./bootstrap";
import { serveHttp } from "./http";
import { PermissionsFile } from "./permissions";
import { registerAllTools } from "./tools";
import { AuditLog, Toolbox } from "./tools/toolbox";
import { VERSION } from "./version";

// stdout carries the MCP protocol in stdio mode: every log line must go to stderr.

// The Synology package runs `synology-mcp package` (its daemon) and `synology-mcp setup` (after the install wizard).
const command = process.argv[2];
if (command === "package" || command === "setup") {
  const run = command === "package" ? (await import("./package/main")).runPackage : (await import("./package/setup")).runSetup;
  try {
    await run();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
} else {
  await runFromEnv();
}

async function runFromEnv(): Promise<void> {
  // Container health check: `synology-mcp --healthcheck` asks the running HTTP server, without loading secrets.
  if (process.argv.includes("--healthcheck")) {
    const port = process.env.SYNO_HTTP_PORT || "8080";
    const ok = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false);
    process.exit(ok ? 0 : 1);
  }

  let setup;
  let permissions: PermissionsFile;
  try {
    setup = await createClientFromEnv();
    permissions = new PermissionsFile(setup.config.permissionsFile);
    await permissions.open();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  const { config, client } = setup;
  const audit = new AuditLog(config.auditLog);
  if (config.legacyAccess) {
    console.error(`[synology] SYNO_ACCESS is no longer used: the rights come from ${config.permissionsFile}`);
  }

  if (config.transport === "http") {
    await serveHttp(config, client, audit, permissions);
  } else {
    serveStdio(async () => {
      const server = new McpServer({ name: "synology", version: VERSION }, { capabilities: { tools: {} } });
      const { domains } = await permissions.load();
      const toolbox = new Toolbox({ server, client, permissions: domains, audit });
      registerAllTools(toolbox);
      console.error(`[synology] ${config.url} — ${toolbox.registered.length} tools, rights from ${config.permissionsFile}`);
      return server;
    });
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      await client.logout().catch(() => {});
      process.exit(0);
    });
  }
}
