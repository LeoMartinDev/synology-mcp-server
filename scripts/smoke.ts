// Read-only connectivity check against the real NAS: logs in and calls each API family once.
// Usage: bun run smoke
import { createClientFromEnv } from "../src/bootstrap";

const { client } = await createClientFromEnv();

const apis = await client.listApis();
console.log(`✓ ${Object.keys(apis).length} APIs exposed`);
for (const name of [
  "SYNO.Core.System",
  "SYNO.Core.Storage.Volume",
  "SYNO.Core.Package",
  "SYNO.Docker.Container",
  "SYNO.FileStation.List",
  "SYNO.Core.Share",
  "SYNO.Core.Share.Permission",
]) {
  console.log(`  ${name}: ${apis[name] ? JSON.stringify(apis[name]) : "MISSING"}`);
}

const checks: [string, () => Promise<unknown>][] = [
  ["system", () => client.call("SYNO.Core.System", "info")],
  ["volumes", () => client.call("SYNO.Core.Storage.Volume", "list", { offset: 0, limit: -1, location: "all" })],
  ["packages", () => client.call("SYNO.Core.Package", "list")],
  ["containers", () => client.call("SYNO.Docker.Container", "list", { limit: -1, offset: 0, type: "all" })],
  ["File Station shares", () => client.call("SYNO.FileStation.List", "list_share")],
  ["shared folders", () => client.call("SYNO.Core.Share", "list", { shareType: "all" })],
  ["users", () => client.call("SYNO.Core.User", "list", { type: "local", offset: 0, limit: 5 })],
];

let failed = false;
for (const [label, run] of checks) {
  try {
    const data = await run();
    console.log(`✓ ${label}: ${JSON.stringify(data).slice(0, 200)}…`);
  } catch (err) {
    failed = true;
    console.log(`✗ ${label}: ${(err as Error).message}`);
  }
}

await client.logout();
process.exit(failed ? 1 : 0);
