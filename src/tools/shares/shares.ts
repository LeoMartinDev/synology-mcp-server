import { z } from "zod";
import type { Toolbox } from "../toolbox";
import { SHARE, shareName } from "./common";

const SHARE_ADDITIONAL = [
  "hidden",
  "encryption",
  "is_aclmode",
  "unite_permission",
  "is_support_acl",
  "recyclebin",
  "share_quota",
];

export function registerShares(tb: Toolbox): void {
  const { client } = tb;

  tb.tool(
    "share_list",
    {
      title: "List shared folders",
      description:
        "List every shared folder of the NAS with its volume, description, recycle bin, encryption, ACL mode and space used in MB (administrator view, unlike file_list_shares).",
      level: "read",
      input: z.object({}),
    },
    () => client.call(SHARE, "list", { shareType: "all", additional: SHARE_ADDITIONAL }),
  );

  tb.tool(
    "share_get",
    {
      title: "Get a shared folder",
      description: "Settings of one shared folder.",
      level: "read",
      input: z.object({ name: shareName }),
    },
    ({ name }) => client.call(SHARE, "get", { name, additional: SHARE_ADDITIONAL }),
  );

  tb.tool(
    "share_create",
    {
      title: "Create a shared folder",
      description:
        "Create a new shared folder on a volume. By default only administrators get access; grant others with share_permission_set.",
      level: "write",
      input: z.object({
        name: shareName,
        volume: z
          .string()
          .regex(/^\/volume\w+$/)
          .default("/volume1")
          .describe("Volume path, e.g. /volume1"),
        description: z.string().default(""),
        hidden: z.boolean().default(false).describe("Hide it in My Network Places"),
        recycle_bin: z.boolean().default(true),
        recycle_bin_admin_only: z.boolean().default(true),
      }),
    },
    ({ name, volume, description, hidden, recycle_bin, recycle_bin_admin_only }) =>
      client.call(SHARE, "create", {
        name,
        shareinfo: {
          name,
          vol_path: volume,
          desc: description,
          hidden,
          enable_recycle_bin: recycle_bin,
          recycle_bin_admin_only,
          name_org: "",
        },
      }),
  );

  tb.tool(
    "share_delete",
    {
      title: "Delete a shared folder",
      description: "Delete a shared folder AND ALL ITS DATA. Irreversible.",
      level: "destructive",
      input: z.object({ name: shareName }),
    },
    ({ name }) => client.call(SHARE, "delete", { name: [name] }),
  );
}
