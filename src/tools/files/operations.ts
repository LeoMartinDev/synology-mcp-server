import { z } from "zod";
import { asJson } from "../../synology/client";
import type { Toolbox } from "../toolbox";
import { FS, path, paths, TASK_APIS, waitForTask, waitSeconds } from "./common";

export function registerOperationTools(tb: Toolbox): void {
  const { client } = tb;

  tb.tool(
    "folder_create",
    {
      title: "Create a folder",
      description: "Create a folder inside an existing folder.",
      level: "write",
      idempotent: true,
      input: z.object({
        parent_path: path,
        name: z.string().min(1).describe("Name of the new folder (not a path)"),
        create_parents: z.boolean().default(false).describe("Create parent_path too if it doesn't exist"),
      }),
    },
    ({ parent_path, name, create_parents }) =>
      client.call(`${FS}.CreateFolder`, "create", {
        folder_path: [parent_path],
        name: [name],
        force_parent: create_parents,
      }),
  );

  tb.tool(
    "file_rename",
    {
      title: "Rename a file or folder",
      description: "Rename a file or folder in place. To move it elsewhere use file_move.",
      level: "write",
      input: z.object({ path, new_name: z.string().min(1).describe("New name (not a path)") }),
    },
    ({ path, new_name }) => client.call(`${FS}.Rename`, "rename", { path: [path], name: [new_name] }),
  );

  const copyMoveInput = z.object({
    paths,
    destination_folder: path,
    on_conflict: z
      .enum(["error", "overwrite", "skip"])
      .default("error")
      .describe("What to do when the destination already contains an item with the same name"),
    wait_seconds: waitSeconds,
  });

  const copyMove = (remove_src: boolean) => async (args: z.output<typeof copyMoveInput>) => {
    const api = TASK_APIS.copy_move;
    const { taskid } = await client.call<{ taskid: string }>(api, "start", {
      path: args.paths,
      dest_folder_path: args.destination_folder,
      overwrite: args.on_conflict === "error" ? undefined : args.on_conflict === "overwrite",
      remove_src,
    });
    return waitForTask(client, api, taskid, args.wait_seconds * 1000);
  };

  tb.tool(
    "file_copy",
    {
      title: "Copy files or folders",
      description: "Copy files or folders (recursively) into a destination folder.",
      level: "write",
      input: copyMoveInput,
    },
    copyMove(false),
  );

  tb.tool(
    "file_move",
    {
      title: "Move files or folders",
      description: "Move files or folders into a destination folder.",
      level: "write",
      input: copyMoveInput,
    },
    copyMove(true),
  );

  tb.tool(
    "file_delete",
    {
      title: "Delete files or folders",
      description:
        "Permanently delete files or folders, recursively. The shared folder's recycle bin, if enabled, may keep a copy.",
      level: "destructive",
      input: z.object({ paths, wait_seconds: waitSeconds }),
    },
    async ({ paths, wait_seconds }) => {
      const api = TASK_APIS.delete;
      const { taskid } = await client.call<{ taskid: string }>(api, "start", { path: paths, recursive: true });
      return waitForTask(client, api, taskid, wait_seconds * 1000);
    },
  );

  tb.tool(
    "file_task_status",
    {
      title: "Check a file operation",
      description: "Progress of a copy, move, delete or dir_size that was still running when its tool returned.",
      level: "read",
      input: z.object({
        kind: z.enum(["copy_move", "delete", "dir_size"]),
        taskid: z.string().min(1),
      }),
    },
    ({ kind, taskid }) => client.call(TASK_APIS[kind], "status", { taskid: asJson(taskid) }),
  );
}
