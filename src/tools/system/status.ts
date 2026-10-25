import { z } from "zod";
import { formatBytes } from "../format";
import type { Toolbox } from "../toolbox";

interface SystemInfo {
  model: string;
  firmware_ver: string;
  firmware_date: string;
  cpu_vendor: string;
  cpu_family: string;
  cpu_series: string;
  cpu_cores: string;
  cpu_clock_speed: number;
  ram_size: number;
  sys_temp: number;
  temperature_warning: boolean;
  up_time: string;
  time: string;
  time_zone_desc: string;
  enabled_ntp: boolean;
  ntp_server: string;
  usb_dev?: unknown[];
}

interface SystemHealth {
  hostname: string;
  interfaces: { id: string; ip: string }[];
  rule?: { description?: { description_params?: string[] } };
}

interface Utilization {
  time: number;
  cpu: { user_load: number; system_load: number; other_load: number; "1min_load": number; "5min_load": number; "15min_load": number };
  memory: { real_usage: number; swap_usage: number; total_real: number; avail_real: number; cached: number };
  disk: { disk: { display_name: string; utilization: number; read_byte: number; write_byte: number }[] };
  space: { volume: { display_name: string; utilization: number; read_byte: number; write_byte: number }[] };
  network: { device: string; rx: number; tx: number }[];
}

const perSecond = (bytes: number) => `${formatBytes(bytes)}/s`;

export function registerStatusTools(tb: Toolbox): void {
  const { client } = tb;

  tb.tool(
    "system_info",
    {
      title: "NAS overview",
      description:
        "Model, DSM version, CPU, RAM, temperature, uptime, time zone, IP addresses and overall health of the NAS.",
      level: "read",
      input: z.object({}),
    },
    async () => {
      const [info, health] = await Promise.all([
        client.call<SystemInfo>("SYNO.Core.System", "info"),
        client.call<SystemHealth>("SYNO.Core.System.SystemHealth", "get"),
      ]);
      return {
        hostname: health.hostname,
        model: info.model,
        dsm: info.firmware_ver,
        dsm_date: info.firmware_date,
        // The dashboard widget's verdict, e.g. "widget:system_ok".
        health: health.rule?.description?.description_params?.[0]?.replace(/^widget:/, ""),
        cpu: `${info.cpu_vendor} ${info.cpu_family} ${info.cpu_series}, ${info.cpu_cores} cores @ ${info.cpu_clock_speed} MHz`,
        ram: formatBytes(info.ram_size * 1024 * 1024),
        temperature_c: info.sys_temp,
        temperature_warning: info.temperature_warning,
        uptime: info.up_time,
        local_time: info.time,
        time_zone: info.time_zone_desc,
        ntp_server: info.enabled_ntp ? info.ntp_server : null,
        network: health.interfaces,
        usb_devices: info.usb_dev,
      };
    },
  );

  tb.tool(
    "system_utilization",
    {
      title: "Resource usage",
      description: "Current CPU, memory, disk, volume and network usage of the NAS.",
      level: "read",
      input: z.object({}),
    },
    async () => {
      const u = await client.call<Utilization>("SYNO.Core.System.Utilization", "get");
      // DSM reports memory in KiB.
      const kib = (n: number) => formatBytes(n * 1024);
      return {
        time: u.time,
        cpu: {
          used_percent: u.cpu.user_load + u.cpu.system_load + u.cpu.other_load,
          user_percent: u.cpu.user_load,
          system_percent: u.cpu.system_load,
          load_1_5_15min: [u.cpu["1min_load"], u.cpu["5min_load"], u.cpu["15min_load"]],
        },
        memory: {
          used_percent: u.memory.real_usage,
          total: kib(u.memory.total_real),
          available: kib(u.memory.avail_real),
          cached: kib(u.memory.cached),
          swap_used_percent: u.memory.swap_usage,
        },
        disks: u.disk.disk.map((d) => ({
          name: d.display_name,
          busy_percent: d.utilization,
          read: perSecond(d.read_byte),
          write: perSecond(d.write_byte),
        })),
        volumes: u.space.volume.map((v) => ({
          name: v.display_name,
          busy_percent: v.utilization,
          read: perSecond(v.read_byte),
          write: perSecond(v.write_byte),
        })),
        network: u.network
          .filter((n) => n.device !== "total")
          .map((n) => ({ device: n.device, received: perSecond(n.rx), sent: perSecond(n.tx) })),
      };
    },
  );

  tb.tool(
    "dsm_update_check",
    {
      title: "Check for DSM updates",
      description: "Ask Synology whether a newer DSM version is available, and whether it is a security update.",
      level: "read",
      input: z.object({}),
    },
    async () => {
      // Versions 2 and up wrap the answer in `update`.
      const data = await client.call<{ update?: unknown }>("SYNO.Core.Upgrade.Server", "check");
      return data.update ?? data;
    },
  );
}
