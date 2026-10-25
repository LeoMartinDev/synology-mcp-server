import { z } from "zod";
import { formatBytes } from "../format";
import type { Toolbox } from "../toolbox";
import { FS, path } from "./common";

interface FileInfo {
  files: { code?: number; isdir?: boolean; additional?: { size?: number } }[];
}

export function registerContentTools(tb: Toolbox): void {
  const { client } = tb;

  tb.tool(
    "file_read",
    {
      title: "Read a text file",
      description:
        "Return the content of a text file: a docker-compose.yml, a configuration file, a log… Binary files and files over max_kb are refused.",
      level: "read",
      input: z.object({
        path,
        max_kb: z.number().int().min(1).max(5120).default(512).describe("Refuse files bigger than this"),
      }),
    },
    async ({ path, max_kb }) => {
      // Check first: a download of a missing or unreadable file only yields an HTTP 404 page.
      const { files } = await client.call<FileInfo>(`${FS}.List`, "getinfo", { path: [path], additional: ["size"] });
      const file = files[0];
      if (!file || file.code) {
        throw new Error(`${path}: no such file, or the DSM account cannot read it [code ${file?.code ?? "?"}]`);
      }
      if (file.isdir) throw new Error(`${path} is a folder; use file_list.`);
      const size = file.additional?.size ?? 0;
      if (size > max_kb * 1024) {
        throw new Error(`${path} is ${formatBytes(size)}, over the ${max_kb} KB limit; raise max_kb to read it.`);
      }

      const bytes = await client.download(`${FS}.Download`, "download", { path: [path], mode: "open" });
      if (bytes.includes(0)) throw new Error(`${path} looks like a binary file; only text files can be read.`);
      return new TextDecoder().decode(bytes);
    },
  );

  tb.tool(
    "file_write",
    {
      title: "Write a text file",
      description:
        "Create a text file, or replace an existing one with overwrite. The whole file is written: to edit one, file_read it first.",
      level: "write",
      input: z.object({
        path: path.describe("Full path of the file, e.g. /docker/app/docker-compose.yml"),
        content: z.string(),
        overwrite: z.boolean().default(false).describe("Replace the file if it already exists"),
        create_parents: z.boolean().default(false).describe("Create the missing parent folders"),
      }),
    },
    async ({ path, content, overwrite, create_parents }) => {
      const slash = path.lastIndexOf("/");
      const folder = path.slice(0, slash);
      const name = path.slice(slash + 1);
      if (!folder || !name) throw new Error(`${path} is not a file path inside a shared folder.`);
      await client.upload(
        `${FS}.Upload`,
        "upload",
        { path: folder, create_parents, overwrite },
        { name, content },
        // Version 2 takes overwrite as a boolean and plain-text parameters, unlike the JSON-encoded rest of File Station.
        { version: 2, encoding: "raw" },
      );
      return `Wrote ${formatBytes(new TextEncoder().encode(content).length)} to ${path}.`;
    },
  );
}
