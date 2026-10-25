import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import type { Domain, Permission } from "../src/permissions";
import { SynologyClient } from "../src/synology/client";
import { registerAllTools } from "../src/tools";
import { AuditLog, Toolbox } from "../src/tools/toolbox";
import { fakeNas, perms, type Route, testConfig } from "./fake-nas";

type Rights = Permission | Record<Domain, Permission>;

async function connect(rights: Rights, routes: Record<string, Route> = {}) {
  const nas = fakeNas(routes);
  const server = new McpServer({ name: "synology", version: "test" }, { capabilities: { tools: {} } });
  const permissions = typeof rights === "string" ? perms(rights) : rights;
  const client = new SynologyClient(testConfig(), nas.fetchImpl);
  registerAllTools(new Toolbox({ server, client, permissions, audit: new AuditLog() }));

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: "test", version: "test" });
  await mcp.connect(clientTransport);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await mcp.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text: string }[]).map((c) => c.text).join("");
    return { isError: result.isError === true, text };
  };
  return { mcp, nas, call };
}

const toolNames = async (rights: Rights) => {
  const { mcp } = await connect(rights);
  return (await mcp.listTools()).tools.map((t) => t.name);
};

describe("permissions", () => {
  test("ro exposes read tools only", async () => {
    const names = await toolNames("ro");
    expect(names).toContain("container_list");
    expect(names).toContain("file_read");
    expect(names).not.toContain("container_stop");
    expect(names).not.toContain("file_write");
  });

  test("rw exposes everything, deletions and reboot included", async () => {
    const names = await toolNames("rw");
    for (const name of ["file_write", "file_delete", "container_delete", "package_uninstall", "system_reboot", "share_delete"]) {
      expect(names).toContain(name);
    }
  });

  test("each part has its own permission; off hides it", async () => {
    const names = await toolNames(perms("ro", { files: "rw", containers: "off" }));
    expect(names).toContain("file_delete");
    expect(names).toContain("system_info");
    expect(names).not.toContain("system_reboot");
    expect(names.filter((n) => n.startsWith("container_") || n === "image_list")).toEqual([]);
  });

  test("raw API calls stay read-only unless discovery is rw", async () => {
    const { call, nas } = await connect(perms("rw", { discovery: "ro" }));
    const result = await call("syno_api_call", { api: "SYNO.Core.Share", method: "delete", params: { name: ["x"] } });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("discovery: rw");
    expect(nas.calls).toHaveLength(0);
  });
});

describe("tools", () => {
  test("container_restart falls back to stop + start", async () => {
    const { call, nas } = await connect("rw", {
      "SYNO.Docker.Container.stop": () => ({ success: true }),
      "SYNO.Docker.Container.start": () => ({ success: true }),
    });
    expect((await call("container_restart", { name: "nginx" })).isError).toBe(false);
    expect(nas.calls.map((c) => c.params.get("method"))).toEqual(["restart", "stop", "start"]);
  });

  test("share_permission_set translates access levels", async () => {
    const { call, nas } = await connect("rw", { "SYNO.Core.Share.Permission.set": () => ({ success: true }) });
    await call("share_permission_set", {
      name: "docker",
      permissions: [
        { principal: "alice", access: "read_only" },
        { principal: "guest", access: "deny" },
      ],
    });
    const params = nas.callsTo("SYNO.Core.Share.Permission.set")[0]!.params;
    expect(params.get("name")).toBe('"docker"');
    expect(params.get("user_group_type")).toBe('"local_user"');
    expect(JSON.parse(params.get("permissions")!)).toEqual([
      { name: "alice", is_custom: false, is_writable: false, is_readonly: true, is_deny: false },
      { name: "guest", is_custom: false, is_writable: false, is_readonly: false, is_deny: true },
    ]);
  });

  test("file_delete waits for the background task", async () => {
    let polls = 0;
    const { call, nas } = await connect("rw", {
      "SYNO.FileStation.Delete.start": () => ({ success: true, data: { taskid: "FileStation_1" } }),
      "SYNO.FileStation.Delete.status": () => ({ success: true, data: { finished: ++polls >= 2 } }),
    });
    const result = await call("file_delete", { paths: ["/docker/old"] });
    expect(JSON.parse(result.text)).toMatchObject({ taskid: "FileStation_1", finished: true });
    const start = nas.callsTo("SYNO.FileStation.Delete.start")[0]!.params;
    expect(start.get("path")).toBe('["/docker/old"]');
    expect(nas.callsTo("SYNO.FileStation.Delete.status")[0]!.params.get("taskid")).toBe('"FileStation_1"');
  });

  test("Synology errors come back as tool errors", async () => {
    const { call } = await connect("ro", {
      "SYNO.FileStation.List.list": () => ({ success: false, error: { code: 408 } }),
    });
    const result = await call("file_list", { folder_path: "/nope" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("No such file or directory");
  });

  test("container_list drops health check outputs and shows dates", async () => {
    const { call } = await connect("ro", {
      "SYNO.Docker.Container.list": () => ({
        success: true,
        data: {
          containers: [{ name: "vpn", created: 1654702794, State: { Health: { Status: "healthy", Log: ["ping…"] } } }],
        },
      }),
    });
    const { containers } = JSON.parse((await call("container_list")).text);
    expect(containers[0]).toEqual({ name: "vpn", created: "2022-06-08T15:39:54Z", State: { Health: { Status: "healthy" } } });
  });

  describe("file_read", () => {
    const routes = (size: number, body: string): Record<string, Route> => ({
      "SYNO.FileStation.List.getinfo": () => ({ success: true, data: { files: [{ isdir: false, additional: { size } }] } }),
      "SYNO.FileStation.Download.download": () => new Response(body),
    });

    test("returns the text", async () => {
      const { call, nas } = await connect("ro", routes(13, "services: {}\n"));
      expect(await call("file_read", { path: "/docker/compose.yml" })).toEqual({ isError: false, text: "services: {}\n" });
      expect(nas.callsTo("SYNO.FileStation.Download.download")[0]!.params.get("path")).toBe('["/docker/compose.yml"]');
    });

    test("refuses big files without downloading them", async () => {
      const { call, nas } = await connect("ro", routes(2 * 1024 * 1024, ""));
      const result = await call("file_read", { path: "/Medias/film.mkv" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("2.00 MiB");
      expect(nas.callsTo("SYNO.FileStation.Download.download")).toHaveLength(0);
    });

    test("refuses binary content", async () => {
      const { call } = await connect("ro", routes(3, "a\u0000b"));
      expect((await call("file_read", { path: "/docker/db.sqlite" })).text).toContain("binary");
    });

    test("explains missing or unreadable files", async () => {
      const { call } = await connect("ro", {
        "SYNO.FileStation.List.getinfo": () => ({ success: true, data: { files: [{ code: 408, path: "/x" }] } }),
      });
      expect((await call("file_read", { path: "/homebridge/auth.json" })).text).toContain("cannot read it");
    });
  });

  test("file_write uploads into the parent folder", async () => {
    const { call, nas } = await connect("rw", { "SYNO.FileStation.Upload.upload": () => ({ success: true }) });
    const result = await call("file_write", { path: "/docker/app/compose.yml", content: "x: 1\n", overwrite: true });
    expect(result).toEqual({ isError: false, text: "Wrote 5 B to /docker/app/compose.yml." });
    const [upload] = nas.callsTo("SYNO.FileStation.Upload.upload");
    expect(upload!.params.get("path")).toBe("/docker/app");
    expect(upload!.params.get("overwrite")).toBe("true");
    expect(upload!.files[0]!.name).toBe("compose.yml");
  });

  test("dir_size waits and adds a readable size", async () => {
    const { call } = await connect("ro", {
      "SYNO.FileStation.DirSize.start": () => ({ success: true, data: { taskid: "t1" } }),
      "SYNO.FileStation.DirSize.status": () => ({ success: true, data: { finished: true, num_file: 36, total_size: 8537124 } }),
    });
    expect(JSON.parse((await call("dir_size", { paths: ["/docker"] })).text)).toEqual({
      taskid: "t1",
      finished: true,
      num_file: 36,
      total_size: 8537124,
      total_size_human: "8.14 MiB",
    });
  });

  test("file_search converts filters, returns the results and cleans the task", async () => {
    const { call, nas } = await connect("ro", {
      "SYNO.FileStation.Search.start": () => ({ success: true, data: { taskid: "s1" } }),
      "SYNO.FileStation.Search.list": () => ({ success: true, data: { finished: true, total: 1, files: [{ path: "/Medias/a.mkv" }] } }),
      "SYNO.FileStation.Search.stop": () => ({ success: true }),
      "SYNO.FileStation.Search.clean": () => ({ success: true }),
    });
    const result = await call("file_search", {
      folder_paths: ["/Medias"],
      extension: "mkv",
      min_size_mb: 1,
      modified_after: "2024-01-01",
      sort_by: "size",
      descending: true,
    });
    expect(JSON.parse(result.text)).toEqual({ taskid: "s1", finished: true, total: 1, files: [{ path: "/Medias/a.mkv" }] });
    const start = nas.callsTo("SYNO.FileStation.Search.start")[0]!.params;
    expect(start.get("size_from")).toBe("1048576");
    expect(start.get("mtime_from")).toBe("1704067200");
    expect(nas.callsTo("SYNO.FileStation.Search.list")[0]!.params.get("sort_direction")).toBe("desc");
    expect(nas.callsTo("SYNO.FileStation.Search.clean")).toHaveLength(1);
  });

  test("package_list flattens the DSM answer", async () => {
    const { call } = await connect("ro", {
      "SYNO.Core.Package.list": () => ({
        success: true,
        data: {
          total: 1,
          packages: [
            {
              id: "DownloadStation",
              name: "Download Station",
              version: "4.0.3",
              timestamp: 1792944300827,
              additional: { status: "stop", startable: true, install_type: "", dependent_packages: { Python2: "" } },
            },
          ],
        },
      }),
    });
    expect(JSON.parse((await call("package_list")).text)).toEqual([
      { id: "DownloadStation", name: "Download Station", version: "4.0.3", status: "stop", startable: true, system: false, depends_on: ["Python2"] },
    ]);
  });

  test("storage_info computes volume usage", async () => {
    const { call } = await connect("ro", {
      "SYNO.Core.Storage.Volume.list": () => ({
        success: true,
        data: { volumes: [{ volume_path: "/volume1", size_total_byte: "4000", size_free_byte: "1000", status: "normal" }] },
      }),
      "SYNO.Core.Storage.Pool.list": () => ({ success: true, data: { pools: [] } }),
      "SYNO.Core.Storage.Disk.list": () => ({
        success: true,
        data: { disks: [{ id: "sda", size_total: "4000787030016", temp: 38, unc: 0, remain_life: { value: -1 } }] },
      }),
    });
    const info = JSON.parse((await call("storage_info")).text);
    expect(info.volumes[0]).toMatchObject({ path: "/volume1", used_percent: 75, used: "2.93 KiB", free: "1000 B" });
    expect(info.disks[0]).toMatchObject({ id: "sda", size: "3.64 TiB", temperature_c: 38, bad_sectors: 0 });
    expect(info.disks[0].remaining_life_percent).toBeUndefined();
  });
});
