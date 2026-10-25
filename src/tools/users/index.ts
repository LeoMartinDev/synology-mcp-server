import { z } from "zod";
import type { Toolbox } from "../toolbox";

/** Local DSM users and groups, the principals permissions are granted to. */
export function registerUserTools(tb: Toolbox): void {
  const { client } = tb;

  tb.tool(
    "user_list",
    {
      title: "List users",
      description: "List the local DSM users, to know who permissions can be granted to.",
      level: "read",
      input: z.object({}),
    },
    () =>
      client.call("SYNO.Core.User", "list", {
        type: "local",
        offset: 0,
        limit: -1,
        additional: ["email", "description", "expired"],
      }),
  );

  tb.tool(
    "group_list",
    {
      title: "List groups",
      description: "List the local DSM groups, to know who permissions can be granted to.",
      level: "read",
      input: z.object({}),
    },
    () => client.call("SYNO.Core.Group", "list", { type: "local", offset: 0, limit: -1, name_only: false }),
  );

  tb.tool(
    "group_members",
    {
      title: "List group members",
      description: "List the users of a local group, e.g. who is in administrators.",
      level: "read",
      input: z.object({ group: z.string().min(1).describe("Group name, as returned by group_list") }),
    },
    ({ group }) => client.call("SYNO.Core.Group.Member", "list", { group, offset: 0, limit: -1, ingroup: true }),
  );
}
