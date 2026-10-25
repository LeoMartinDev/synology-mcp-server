import { z } from "zod";
import { SynologyError } from "../../synology/errors";
import type { Toolbox } from "../toolbox";

const CONTAINER = "SYNO.Docker.Container";

const containerName = z.string().min(1).describe("Container name, as returned by container_list");

interface ContainerList {
  containers?: { State?: { Health?: { Log?: unknown } } }[];
}

export function registerContainers(tb: Toolbox): void {
  const { client } = tb;

  tb.tool(
    "container_list",
    {
      title: "List containers",
      description: "List every Docker container of Container Manager (running or not) with its image and status.",
      level: "read",
      input: z.object({}),
    },
    async () => {
      const data = await client.call<ContainerList>(CONTAINER, "list", { limit: -1, offset: 0, type: "all" });
      // Health checks keep their last outputs (often pages of ping logs); container_get still shows them.
      for (const container of data.containers ?? []) delete container.State?.Health?.Log;
      return data;
    },
  );

  tb.tool(
    "container_get",
    {
      title: "Get container details",
      description:
        "Full configuration and state of one container: image, ports, volumes, environment, network, restart policy, health check results.",
      level: "read",
      input: z.object({ name: containerName }),
    },
    ({ name }) => client.call(CONTAINER, "get", { name }),
  );

  tb.tool(
    "container_logs",
    {
      title: "Read container logs",
      description: "Read the log lines of a container, newest first by default.",
      level: "read",
      input: z.object({
        name: containerName,
        limit: z.number().int().min(1).max(5000).default(200),
        offset: z.number().int().min(0).default(0),
        keyword: z.string().optional().describe("Only return lines containing this text"),
        newest_first: z.boolean().default(true),
      }),
    },
    ({ name, limit, offset, keyword, newest_first }) =>
      client.call(`${CONTAINER}.Log`, "get", {
        name,
        limit,
        offset,
        keyword,
        sort_dir: newest_first ? "DESC" : "ASC",
      }),
  );

  tb.tool(
    "container_stats",
    {
      title: "Container resource usage",
      description: "Current CPU and memory usage of every running container.",
      level: "read",
      input: z.object({}),
    },
    () => client.call(`${CONTAINER}.Resource`, "get"),
  );

  tb.tool(
    "container_start",
    {
      title: "Start a container",
      description: "Start a stopped container.",
      level: "write",
      idempotent: true,
      input: z.object({ name: containerName }),
    },
    ({ name }) => client.call(CONTAINER, "start", { name }),
  );

  tb.tool(
    "container_stop",
    {
      title: "Stop a container",
      description: "Stop a running container.",
      level: "write",
      idempotent: true,
      input: z.object({ name: containerName }),
    },
    ({ name }) => client.call(CONTAINER, "stop", { name }),
  );

  tb.tool(
    "container_restart",
    {
      title: "Restart a container",
      description: "Restart a container (stop then start).",
      level: "write",
      input: z.object({ name: containerName }),
    },
    async ({ name }) => {
      try {
        return await client.call(CONTAINER, "restart", { name });
      } catch (err) {
        // Older Container Manager / Docker packages have no restart method.
        if (!(err instanceof SynologyError) || err.code !== 103) throw err;
        await client.call(CONTAINER, "stop", { name });
        return client.call(CONTAINER, "start", { name });
      }
    },
  );

  tb.tool(
    "container_delete",
    {
      title: "Delete a container",
      description:
        "Delete a container. Its image and the host folders mounted as volumes are kept. Irreversible: the container's own filesystem is lost.",
      level: "destructive",
      input: z.object({
        name: containerName,
        force: z.boolean().default(false).describe("Also delete the container if it is running"),
      }),
    },
    ({ name, force }) => client.call(CONTAINER, "delete", { name, force, preserve_profile: false }),
  );
}
