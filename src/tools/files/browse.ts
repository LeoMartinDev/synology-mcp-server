import { z } from "zod";
import { asJson } from "../../synology/client";
import { formatBytes } from "../format";
import type { Toolbox } from "../toolbox";
import { FILE_ADDITIONAL, FS, path, paths, TASK_APIS, type TaskStatus, waitForTask, waitSeconds } from "./common";

const isoDate = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO date, e.g. 2024-01-31")
  .describe("ISO date or date-time, e.g. 2024-01-31");
const toUnix = (date?: string) => (date === undefined ? undefined : Math.floor(Date.parse(date) / 1000));

const megabytes = z.number().min(0);
const toBytes = (mb?: number) => (mb === undefined ? undefined : Math.round(mb * 1024 * 1024));

interface SearchPage extends TaskStatus {
  files?: unknown[];
  total?: number;
}

export function registerBrowseTools(tb: Toolbox): void {
  const { client } = tb;

  tb.tool(
    "file_list_shares",
    {
      title: "List shared folders (File Station)",
      description:
        "List the shared folders visible to the account in File Station, with their real path on the volume and the account's permissions. These are the roots of every File Station path.",
      level: "read",
      input: z.object({}),
    },
    () =>
      client.call(`${FS}.List`, "list_share", {
        additional: ["real_path", "owner", "time", "perm", "volume_status"],
      }),
  );

  tb.tool(
    "file_list",
    {
      title: "List a folder",
      description:
        "List the files and folders inside a folder, with size, owner, times and permissions. The size of a folder here is not its content's; use dir_size for that.",
      level: "read",
      input: z.object({
        folder_path: path,
        pattern: z.string().optional().describe("Glob filter on names, e.g. *.yml"),
        type: z.enum(["all", "file", "dir"]).default("all"),
        sort_by: z.enum(["name", "size", "user", "group", "mtime", "type"]).default("name"),
        descending: z.boolean().default(false),
        limit: z.number().int().min(1).max(5000).default(500),
        offset: z.number().int().min(0).default(0),
      }),
    },
    ({ folder_path, pattern, type, sort_by, descending, limit, offset }) =>
      client.call(`${FS}.List`, "list", {
        folder_path,
        pattern,
        filetype: type,
        sort_by,
        sort_direction: descending ? "desc" : "asc",
        limit,
        offset,
        additional: FILE_ADDITIONAL,
      }),
  );

  tb.tool(
    "file_info",
    {
      title: "Get file or folder info",
      description: "Size, owner, times, real path and permissions of one or more files or folders.",
      level: "read",
      input: z.object({ paths }),
    },
    ({ paths }) => client.call(`${FS}.List`, "getinfo", { path: paths, additional: FILE_ADDITIONAL }),
  );

  tb.tool(
    "dir_size",
    {
      title: "Measure folder size",
      description:
        "Total size and number of files and folders inside one or more folders, counted recursively. Can take minutes on large folders.",
      level: "read",
      input: z.object({ paths, wait_seconds: waitSeconds }),
    },
    async ({ paths, wait_seconds }) => {
      const api = TASK_APIS.dir_size;
      const { taskid } = await client.call<{ taskid: string }>(api, "start", { path: paths });
      const status = await waitForTask<TaskStatus & { total_size?: number }>(client, api, taskid, wait_seconds * 1000);
      return status.total_size === undefined ? status : { ...status, total_size_human: formatBytes(status.total_size) };
    },
  );

  tb.tool(
    "file_search",
    {
      title: "Search files",
      description:
        "Search files and folders recursively by name, extension, size or modification date. Sort by size, descending, to find what takes space.",
      level: "read",
      input: z.object({
        folder_paths: paths.describe("Folders to search in, e.g. [\"/Medias\"]"),
        pattern: z.string().optional().describe("Glob on names, e.g. *.mkv or *backup*"),
        extension: z.string().optional().describe("File extension without the dot, e.g. mkv"),
        type: z.enum(["all", "file", "dir"]).default("all"),
        min_size_mb: megabytes.optional(),
        max_size_mb: megabytes.optional(),
        modified_after: isoDate.optional(),
        modified_before: isoDate.optional(),
        sort_by: z.enum(["name", "size", "mtime"]).default("name"),
        descending: z.boolean().default(false),
        limit: z.number().int().min(1).max(1000).default(100),
        offset: z.number().int().min(0).default(0),
        wait_seconds: waitSeconds.describe("How long to search before returning the results found so far"),
      }),
    },
    async (args) => {
      const api = `${FS}.Search`;
      const { taskid } = await client.call<{ taskid: string }>(api, "start", {
        folder_path: args.folder_paths,
        recursive: true,
        pattern: args.pattern,
        extension: args.extension,
        filetype: args.type,
        size_from: toBytes(args.min_size_mb),
        size_to: toBytes(args.max_size_mb),
        mtime_from: toUnix(args.modified_after),
        mtime_to: toUnix(args.modified_before),
      });
      try {
        const page = await waitForTask<SearchPage>(client, api, taskid, args.wait_seconds * 1000, "list", {
          offset: args.offset,
          limit: args.limit,
          sort_by: args.sort_by,
          sort_direction: args.descending ? "desc" : "asc",
          additional: ["real_path", "size", "owner", "time"],
        });
        const { note, ...results } = page;
        return page.finished ? results : { ...results, note: "Search timed out; these are partial results." };
      } finally {
        // Search tasks hold their results on the NAS until cleaned.
        await client.call(api, "stop", { taskid: asJson(taskid) }).catch(() => {});
        await client.call(api, "clean", { taskid: asJson(taskid) }).catch(() => {});
      }
    },
  );
}
