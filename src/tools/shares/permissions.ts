import { z } from "zod";
import type { Toolbox } from "../toolbox";
import { SHARE, shareName } from "./common";

const principalType = z
  .enum(["local_user", "local_group", "system"])
  .default("local_user")
  .describe("local_user / local_group, or system for built-in accounts such as guest");

/** Maps a simple access level onto the flags DSM stores for each user or group. */
const ACCESS_FLAGS = {
  read_write: { is_writable: true, is_readonly: false, is_deny: false },
  read_only: { is_writable: false, is_readonly: true, is_deny: false },
  deny: { is_writable: false, is_readonly: false, is_deny: true },
  none: { is_writable: false, is_readonly: false, is_deny: false },
} as const;

export function registerPermissions(tb: Toolbox): void {
  const { client } = tb;

  tb.tool(
    "share_permission_list",
    {
      title: "List shared folder permissions",
      description:
        "Permissions of every user (or group) on a shared folder: read/write, read-only, deny, or none.",
      level: "read",
      input: z.object({
        name: shareName,
        principal_type: principalType,
        limit: z.number().int().min(1).max(1000).default(200),
        offset: z.number().int().min(0).default(0),
      }),
    },
    ({ name, principal_type, limit, offset }) =>
      client.call(`${SHARE}.Permission`, "list", {
        name,
        user_group_type: principal_type,
        action: "enum",
        offset,
        limit,
        is_unite_permission: false,
        with_inherit: false,
      }),
  );

  tb.tool(
    "share_permission_set",
    {
      title: "Set shared folder permissions",
      description:
        "Set the access of users or groups on a shared folder. Only the listed principals change. 'none' removes the explicit permission; 'deny' overrides any group grant.",
      level: "write",
      idempotent: true,
      input: z.object({
        name: shareName,
        principal_type: principalType,
        permissions: z
          .array(
            z.object({
              principal: z.string().min(1).describe("User or group name"),
              access: z.enum(["read_write", "read_only", "deny", "none"]),
            }),
          )
          .min(1),
      }),
    },
    ({ name, principal_type, permissions }) =>
      client.call(`${SHARE}.Permission`, "set", {
        name,
        user_group_type: principal_type,
        permissions: permissions.map((p) => ({ name: p.principal, is_custom: false, ...ACCESS_FLAGS[p.access] })),
      }),
  );
}
