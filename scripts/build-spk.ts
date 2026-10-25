// Builds the Synology package (.spk) from package/ and a Linux x86-64 binary, without Synology's toolkit:
// an .spk is a plain tar holding INFO, package.tgz (what DSM extracts to /var/packages/SynologyMCP/target),
// the lifecycle scripts, conf/, the install wizard and the icons.
// Usage: bun run scripts/build-spk.ts <linux binary> [output dir]   (BUILD_NUMBER sets the package build)
import { createHash } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import pkg from "../package.json";

const PACKAGE = "SynologyMCP";
const APP_CLASS = "SYNO.SDS.SynologyMCP.Instance";
const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "package");

const [binary, outDir = join(ROOT, "dist")] = process.argv.slice(2);
if (!binary) {
  console.error("Usage: bun run scripts/build-spk.ts <linux binary> [output dir]");
  process.exit(1);
}

interface Entry {
  path: string;
  /** Undefined for a directory. */
  content?: Uint8Array;
  mode: number;
}

/** A POSIX ustar archive; owners are root and modes explicit, whatever the machine building it. */
function tar(entries: Entry[]): Uint8Array<ArrayBuffer> {
  const blocks: Uint8Array[] = [];
  const mtime = Math.floor(Date.now() / 1000);
  for (const entry of entries) {
    const isDir = entry.content === undefined;
    const name = isDir ? `${entry.path}/` : entry.path;
    if (name.length > 99) throw new Error(`path too long for ustar: ${name}`);
    const header = new Uint8Array(512);
    const put = (offset: number, length: number, value: string) =>
      header.set(new TextEncoder().encode(value).subarray(0, length), offset);
    const octal = (offset: number, length: number, value: number) =>
      put(offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
    put(0, 100, name);
    octal(100, 8, entry.mode);
    octal(108, 8, 0);
    octal(116, 8, 0);
    octal(124, 12, entry.content?.length ?? 0);
    octal(136, 12, mtime);
    put(148, 8, "        ");
    put(156, 1, isDir ? "5" : "0");
    put(257, 6, "ustar\0");
    put(263, 2, "00");
    put(265, 32, "root");
    put(297, 32, "root");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    put(148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(header);
    if (entry.content) {
      blocks.push(entry.content);
      const padding = (512 - (entry.content.length % 512)) % 512;
      if (padding) blocks.push(new Uint8Array(padding));
    }
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}

/** Every file under `dir`, as archive entries under `prefix`, directories first. */
async function tree(dir: string, prefix: string, mode: (path: string) => number): Promise<Entry[]> {
  const entries: Entry[] = [{ path: prefix, mode: 0o755 }];
  for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, item.name);
    const name = `${prefix}/${item.name}`;
    if (item.isDirectory()) entries.push(...(await tree(path, name, mode)));
    else entries.push({ path: name, content: await Bun.file(path).bytes(), mode: mode(name) });
  }
  return entries;
}

const file = async (path: string) => Bun.file(path).bytes();
const text = (value: string) => new TextEncoder().encode(value);

const build = String(Number(process.env.BUILD_NUMBER ?? 1)).padStart(4, "0");
const version = `${pkg.version}-${build}`;
// The version in the script's name makes browsers load the new window after an upgrade.
const script = `${PACKAGE}-${version}.js`;

// What DSM extracts to /var/packages/SynologyMCP/target.
const ui = (await tree(join(SRC, "target", "ui"), "ui", () => 0o644)).filter((e) => e.path !== "ui/SynologyMCP.js");
const appConfig = {
  [script]: {
    [APP_CLASS]: {
      type: "app",
      title: "Synology MCP",
      desc: "Serveur MCP : Claude gère le NAS",
      appWindow: APP_CLASS,
      icon: "images/icon_{0}.png",
      allUsers: false,
      allowMultiInstance: false,
      hidden: false,
      depend: [],
    },
  },
};
const payload: Entry[] = [
  { path: "bin", mode: 0o755 },
  { path: "bin/synology-mcp", content: await file(binary), mode: 0o755 },
  ...(await tree(join(SRC, "target", "nginx"), "nginx", () => 0o644)),
  ...ui,
  { path: `ui/${script}`, content: await file(join(SRC, "target", "ui", "SynologyMCP.js")), mode: 0o644 },
  { path: "ui/config", content: text(`${JSON.stringify(appConfig, null, 2)}\n`), mode: 0o644 },
];
const packageTgz = Bun.gzipSync(tar(payload), { level: 9 });
const extractKb = Math.ceil(payload.reduce((n, e) => n + (e.content?.length ?? 0), 0) / 1024);

const info = {
  package: PACKAGE,
  version,
  os_min_ver: "7.2-64561",
  arch: "x86_64",
  thirdparty: "yes",
  displayname: "Synology MCP",
  description: "MCP server for Claude (claude.ai, Claude Code): manage the NAS from Claude, with DSM accounts and per-part rights.",
  description_fre:
    "Serveur MCP pour Claude (claude.ai, Claude Code) : gérez le NAS depuis Claude, avec connexion par compte DSM et droits par partie.",
  maintainer: "LeoMartinDev",
  maintainer_url: "https://github.com/LeoMartinDev/synology-mcp-server",
  support_url: "https://github.com/LeoMartinDev/synology-mcp-server/issues",
  dsmuidir: "ui",
  dsmappname: APP_CLASS,
  // DSM's web server includes package/target/nginx: it must reload when the package comes and goes.
  instuninst_restart_services: "nginx.service",
  ctl_stop: "yes",
  silent_upgrade: "yes",
  extractsize: String(extractKb),
  checksum: createHash("md5").update(packageTgz).digest("hex"),
};
const infoText = `${Object.entries(info)
  .map(([key, value]) => `${key}="${value.replaceAll('"', '\\"')}"`)
  .join("\n")}\n`;

const spk = tar([
  { path: "INFO", content: text(infoText), mode: 0o644 },
  { path: "package.tgz", content: packageTgz, mode: 0o644 },
  ...(await tree(join(SRC, "scripts"), "scripts", () => 0o755)),
  ...(await tree(join(SRC, "conf"), "conf", () => 0o644)),
  ...(await tree(join(SRC, "WIZARD_UIFILES"), "WIZARD_UIFILES", () => 0o644)),
  { path: "PACKAGE_ICON.PNG", content: await file(join(SRC, "PACKAGE_ICON.PNG")), mode: 0o644 },
  { path: "PACKAGE_ICON_256.PNG", content: await file(join(SRC, "PACKAGE_ICON_256.PNG")), mode: 0o644 },
]);

await mkdir(outDir, { recursive: true });
const output = join(outDir, `${PACKAGE}-${version}-x86_64.spk`);
await Bun.write(output, spk);
console.log(`${relative(process.cwd(), output)} (${(spk.length / 1024 / 1024).toFixed(1)} MiB)`);
