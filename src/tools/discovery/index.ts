import { z } from "zod";
import type { Toolbox } from "../toolbox";

/** Methods that only read state; anything else through the raw call needs "discovery: rw". */
const READ_METHOD = /^(get|list|query|info|status|enum)/i;

export function registerDiscoveryTools(tb: Toolbox): void {
  const { client } = tb;
  const unrestricted = tb.permission === "rw";

  tb.tool(
    "syno_api_list",
    {
      title: "List DSM APIs",
      description:
        "List the Web APIs exposed by this NAS (name, versions, request format), optionally filtered. Use it before syno_api_call to find APIs not covered by dedicated tools.",
      level: "read",
      input: z.object({
        filter: z.string().optional().describe("Case-insensitive substring, e.g. Docker or Core.Share"),
      }),
    },
    async ({ filter }) => {
      const apis = await client.listApis();
      const needle = filter?.toLowerCase();
      return Object.fromEntries(
        Object.entries(apis)
          .filter(([name]) => !needle || name.toLowerCase().includes(needle))
          .sort(([a], [b]) => a.localeCompare(b)),
      );
    },
  );

  tb.tool(
    "syno_api_call",
    {
      title: "Call a DSM API",
      description: unrestricted
        ? "Call any DSM Web API method directly. Prefer the dedicated tools; use this for what they don't cover. It can change or delete anything."
        : "Call a read-only DSM Web API method directly (method names starting with get, list, query, info, status or enum). Prefer the dedicated tools.",
      level: unrestricted ? "destructive" : "read",
      input: z.object({
        api: z.string().regex(/^SYNO\./).describe("API name, e.g. SYNO.Core.System"),
        method: z.string().min(1),
        version: z.number().int().positive().optional().describe("Defaults to the highest supported version"),
        params: z.record(z.string(), z.unknown()).default({}),
        encoding: z
          .enum(["auto", "json", "raw"])
          .default("auto")
          .describe("auto follows the API's request format; json quotes every string; raw sends strings as-is"),
      }),
    },
    async ({ api, method, version, params, encoding }) => {
      if (api === "SYNO.API.Auth") throw new Error("Authentication is handled by the server itself.");
      if (!unrestricted && !READ_METHOD.test(method)) {
        throw new Error(`Method "${method}" may modify the NAS; it requires "discovery: rw" in the permissions file.`);
      }
      return client.call(api, method, params, { version, encoding });
    },
  );
}
