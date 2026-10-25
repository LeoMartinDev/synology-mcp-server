import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { asJson, encodeParams, SynologyClient } from "../src/synology/client";
import { SynologyError } from "../src/synology/errors";
import { fakeNas, testConfig } from "./fake-nas";

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (err: SynologyError) => err,
  );

describe("encodeParams", () => {
  test("raw format keeps strings, JSON-encodes the rest", () => {
    expect(encodeParams({ a: "x", b: 2, c: true, d: ["/p"], e: undefined, f: asJson("t") }, false)).toEqual({
      a: "x",
      b: "2",
      c: "true",
      d: '["/p"]',
      f: '"t"',
    });
  });

  test("JSON format quotes strings too", () => {
    expect(encodeParams({ name: "nginx", force: false }, true)).toEqual({ name: '"nginx"', force: "false" });
  });
});

describe("SynologyClient", () => {
  test("logs in lazily and sends the session id and token", async () => {
    const nas = fakeNas({ "SYNO.FileStation.List.list_share": () => ({ success: true, data: { shares: [] } }) });
    const client = new SynologyClient(testConfig(), nas.fetchImpl);

    expect(await client.call("SYNO.FileStation.List", "list_share")).toEqual({ shares: [] });
    const [call] = nas.calls;
    expect(call!.url).toBe("https://nas.test:5001/webapi/entry.cgi");
    expect(call!.params.get("_sid")).toBe("sid-1");
    expect(call!.params.get("version")).toBe("2");
    expect(call!.headers["X-SYNO-TOKEN"]).toBe("token-1");
    expect(nas.logins).toBe(1);
  });

  test("follows the API's JSON request format", async () => {
    const nas = fakeNas({ "SYNO.Docker.Container.start": () => ({ success: true }) });
    await new SynologyClient(testConfig(), nas.fetchImpl).call("SYNO.Docker.Container", "start", { name: "nginx" });
    expect(nas.callsTo("SYNO.Docker.Container.start")[0]!.params.get("name")).toBe('"nginx"');
  });

  test("logs in again once when the session expired", async () => {
    let first = true;
    const nas = fakeNas({
      "SYNO.Core.Share.list": () => {
        if (first) {
          first = false;
          return { success: false, error: { code: 119 } };
        }
        return { success: true, data: { shares: ["docker"] } };
      },
    });
    const client = new SynologyClient(testConfig(), nas.fetchImpl);
    expect(await client.call("SYNO.Core.Share", "list")).toEqual({ shares: ["docker"] });
    expect(nas.logins).toBe(2);
    expect(nas.callsTo("SYNO.Core.Share.list")[1]!.params.get("_sid")).toBe("sid-2");
  });

  test("maps error codes per API family", async () => {
    const nas = fakeNas({
      "SYNO.FileStation.List.getinfo": () => ({ success: false, error: { code: 408 } }),
    });
    const err = await failure(new SynologyClient(testConfig(), nas.fetchImpl).call("SYNO.FileStation.List", "getinfo"));
    expect(err).toBeInstanceOf(SynologyError);
    expect(err.message).toContain("No such file or directory");
  });

  test("download returns the raw bytes and still reports DSM errors", async () => {
    const nas = fakeNas({
      "SYNO.FileStation.Download.download": (params) =>
        params.get("path") === '["/docker/a.yml"]'
          ? new Response("services: {}\n", { headers: { "content-type": "application/octet-stream" } })
          : { success: false, error: { code: 408 } },
    });
    const client = new SynologyClient(testConfig(), nas.fetchImpl);
    const bytes = await client.download("SYNO.FileStation.Download", "download", { path: ["/docker/a.yml"] });
    expect(new TextDecoder().decode(bytes)).toBe("services: {}\n");
    const err = await failure(client.download("SYNO.FileStation.Download", "download", { path: ["/nope"] }));
    expect(err.code).toBe(408);
  });

  test("upload sends the API in the query and the file after the parameters", async () => {
    const nas = fakeNas({ "SYNO.FileStation.Upload.upload": () => ({ success: true }) });
    const client = new SynologyClient(testConfig(), nas.fetchImpl);
    await client.upload(
      "SYNO.FileStation.Upload",
      "upload",
      { path: "/docker/app", overwrite: true },
      { name: "compose.yml", content: "x: 1" },
      { version: 2, encoding: "raw" },
    );
    const [call] = nas.callsTo("SYNO.FileStation.Upload.upload");
    expect(call!.params.get("version")).toBe("2");
    expect(call!.params.get("_sid")).toBe("sid-1");
    expect(call!.params.get("path")).toBe("/docker/app");
    expect(call!.params.get("overwrite")).toBe("true");
    expect(call!.files.map((f) => f.name)).toEqual(["compose.yml"]);
    expect(await call!.files[0]!.text()).toBe("x: 1");
  });

  test("rejects APIs the NAS doesn't expose", async () => {
    const nas = fakeNas();
    const err = await failure(new SynologyClient(testConfig(), nas.fetchImpl).call("SYNO.Docker.Project", "list"));
    expect(err.code).toBe(102);
    expect(err.message).toContain("Container Manager");
  });
});

describe("loadConfig", () => {
  test("strips the trailing slash and keeps the permissions file in the data folder", () => {
    const config = loadConfig({ SYNO_URL: "https://nas:5001/", SYNO_USERNAME: "a", SYNO_PASSWORD: "b", SYNO_DATA_DIR: "/data" });
    expect(config.url).toBe("https://nas:5001");
    expect(config.permissionsFile.replaceAll("\\", "/")).toBe("/data/permissions.yml");
    expect(config.insecureTls).toBe(false);
    expect(config.legacyAccess).toBeUndefined();
  });

  test("notices the replaced SYNO_ACCESS", () => {
    const config = loadConfig({ SYNO_URL: "https://nas:5001", SYNO_USERNAME: "a", SYNO_PASSWORD: "b", SYNO_ACCESS: "read" });
    expect(config.legacyAccess).toBe("read");
  });

  test("reports missing variables", () => {
    expect(() => loadConfig({})).toThrow(/SYNO_URL/);
  });
});
