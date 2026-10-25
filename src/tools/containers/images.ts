import { z } from "zod";
import type { Toolbox } from "../toolbox";

export function registerImages(tb: Toolbox): void {
  const { client } = tb;

  tb.tool(
    "image_list",
    {
      title: "List images",
      description: "List the Docker images downloaded on the NAS, with their size and tags.",
      level: "read",
      input: z.object({}),
    },
    () => client.call("SYNO.Docker.Image", "list", { limit: -1, offset: 0, show_dsm: false }),
  );
}
