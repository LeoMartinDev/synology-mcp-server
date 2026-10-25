import { z } from "zod";
import type { Toolbox } from "../toolbox";

// DSM silently ignores any other spelling ("warn", "error") and returns every level.
const LOG_LEVELS = { info: "info", warning: "warning", error: "err" } as const;

export function registerActivityTools(tb: Toolbox): void {
  const { client } = tb;

  tb.tool(
    "system_logs",
    {
      title: "Read DSM logs",
      description:
        "Read the DSM log, newest first: system events (settings, users, packages, disks) or connections (sign-ins, failed logins, file access).",
      level: "read",
      input: z.object({
        type: z.enum(["system", "connection"]).default("system"),
        level: z.enum(["info", "warning", "error"]).optional().describe("Only this severity"),
        keyword: z.string().optional().describe("Only entries containing this text, e.g. a user name or IP"),
        limit: z.number().int().min(1).max(1000).default(100),
        offset: z.number().int().min(0).default(0),
      }),
    },
    ({ type, level, keyword, limit, offset }) =>
      client.call("SYNO.Core.SyslogClient.Log", "list", {
        start: offset,
        limit,
        target: "LOCAL",
        logtype: type,
        dir: "desc",
        level: level && LOG_LEVELS[level],
        keyword,
      }),
  );

  tb.tool(
    "system_connections",
    {
      title: "List connected users",
      description: "Who is connected to the NAS right now, from where and through what (DSM, SMB, WebDAV…).",
      level: "read",
      input: z.object({}),
    },
    () =>
      client.call("SYNO.Core.CurrentConnection", "list", {
        start: 0,
        limit: -1,
        sort_by: "time",
        sort_direction: "DESC",
      }),
  );
}
