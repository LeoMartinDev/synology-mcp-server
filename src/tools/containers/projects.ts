import { z } from "zod";
import type { Toolbox } from "../toolbox";

export function registerProjects(tb: Toolbox): void {
  const { client } = tb;

  tb.tool(
    "project_list",
    {
      title: "List Compose projects",
      description: "List the Container Manager projects (docker-compose stacks) with their status and path.",
      level: "read",
      input: z.object({}),
    },
    () => client.call("SYNO.Docker.Project", "list"),
  );
}
