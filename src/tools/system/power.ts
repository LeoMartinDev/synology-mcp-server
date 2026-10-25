import { z } from "zod";
import type { Toolbox } from "../toolbox";

// Parameters of DSM's own power menu; `force` would skip the check for running tasks.
const POWER_PARAMS = { force: false, local: true };

export function registerPowerTools(tb: Toolbox): void {
  const { client } = tb;

  tb.tool(
    "system_reboot",
    {
      title: "Reboot the NAS",
      description:
        "Reboot the NAS. Every service and container stops for a few minutes, and connections (including this one) drop.",
      level: "destructive",
      input: z.object({}),
    },
    async () => {
      await client.call("SYNO.Core.System", "reboot", POWER_PARAMS, { version: 1 });
      return "Reboot requested; the NAS will be unreachable for a few minutes.";
    },
  );

  tb.tool(
    "system_shutdown",
    {
      title: "Shut down the NAS",
      description:
        "Power off the NAS. It stays off until someone presses its power button or wakes it with Wake-on-LAN.",
      level: "destructive",
      input: z.object({}),
    },
    async () => {
      await client.call("SYNO.Core.System", "shutdown", POWER_PARAMS, { version: 1 });
      return "Shutdown requested.";
    },
  );
}
