import { z } from "zod";
import { asJson, type SynologyClient } from "../../synology/client";

export const FS = "SYNO.FileStation";

export const path = z
  .string()
  .startsWith("/")
  .describe("Absolute File Station path starting with the shared folder, e.g. /docker/app");
export const paths = z.array(path).min(1);

export const FILE_ADDITIONAL = ["real_path", "size", "owner", "time", "perm", "type"];

/** File Station operations that run as background tasks, by the kind file_task_status takes. */
export const TASK_APIS = {
  copy_move: `${FS}.CopyMove`,
  delete: `${FS}.Delete`,
  dir_size: `${FS}.DirSize`,
} as const;

export const waitSeconds = z
  .number()
  .int()
  .min(0)
  .max(600)
  .default(60)
  .describe("How long to wait for the operation to finish before returning its task id");

export interface TaskStatus {
  finished?: boolean;
  [key: string]: unknown;
}

/** Polls a File Station background task until it finishes or the wait budget runs out. */
export async function waitForTask<S extends TaskStatus = TaskStatus>(
  client: SynologyClient,
  api: string,
  taskid: string,
  timeoutMs: number,
  method = "status",
  params: Record<string, unknown> = {},
): Promise<S & { taskid: string; note?: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await client.call<S>(api, method, { taskid: asJson(taskid), ...params });
    if (status.finished) return { taskid, ...status };
    if (Date.now() >= deadline) {
      return { taskid, ...status, note: "Still running; check again with file_task_status." };
    }
    await Bun.sleep(500);
  }
}
