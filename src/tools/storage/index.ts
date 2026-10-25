import { z } from "zod";
import { formatBytes, percent } from "../format";
import type { Toolbox } from "../toolbox";

interface Volumes {
  volumes: {
    volume_path: string;
    display_name: string;
    status: string;
    fs_type: string;
    raid_type: string;
    pool_path: string;
    size_total_byte: string;
    size_free_byte: string;
    crashed: boolean;
    readonly: boolean;
  }[];
}

interface Pools {
  pools: {
    id: string;
    desc: string;
    status: string;
    disks: string[];
    size: { total: string; used: string };
    scrubbingStatus?: string;
    last_done_time?: number;
    disk_failure_number?: number;
  }[];
}

interface Disks {
  disks: {
    id: string;
    name: string;
    model: string;
    serial: string;
    size_total: string;
    temp: number;
    status: string;
    smart_status: string;
    unc: number;
    used_by: string;
    remain_life?: { value: number };
  }[];
}

/** Volumes, storage pools and drives. */
export function registerStorageTools(tb: Toolbox): void {
  const { client } = tb;

  tb.tool(
    "storage_info",
    {
      title: "Storage overview",
      description:
        "Space used and free on each volume, health of each storage pool (RAID) and drive (SMART status, temperature, bad sectors).",
      level: "read",
      input: z.object({}),
    },
    async () => {
      const page = { offset: 0, limit: -1 };
      const [{ volumes }, { pools }, { disks }] = await Promise.all([
        client.call<Volumes>("SYNO.Core.Storage.Volume", "list", { ...page, location: "all" }),
        client.call<Pools>("SYNO.Core.Storage.Pool", "list", page),
        client.call<Disks>("SYNO.Core.Storage.Disk", "list", page),
      ]);
      return {
        volumes: volumes.map((v) => {
          const total = Number(v.size_total_byte);
          const used = total - Number(v.size_free_byte);
          return {
            path: v.volume_path,
            name: v.display_name,
            status: v.status,
            fs_type: v.fs_type,
            raid_type: v.raid_type,
            pool: v.pool_path,
            total: formatBytes(total),
            used: formatBytes(used),
            free: formatBytes(v.size_free_byte),
            used_percent: percent(used, total),
            crashed: v.crashed,
            readonly: v.readonly,
          };
        }),
        pools: pools.map((p) => ({
          id: p.id,
          raid: p.desc,
          status: p.status,
          disks: p.disks,
          failed_disks: p.disk_failure_number ?? 0,
          // A pool's size counts what is allocated to volumes, not the files in them.
          allocated: `${formatBytes(p.size.used)} of ${formatBytes(p.size.total)}`,
          scrubbing: p.scrubbingStatus,
          last_scrubbing_time: p.last_done_time,
        })),
        disks: disks.map((d) => ({
          id: d.id,
          name: d.name,
          model: d.model,
          serial: d.serial,
          size: formatBytes(d.size_total),
          status: d.status,
          smart_status: d.smart_status,
          temperature_c: d.temp,
          bad_sectors: d.unc,
          // -1 for hard drives, which report no remaining life.
          remaining_life_percent: d.remain_life && d.remain_life.value >= 0 ? d.remain_life.value : undefined,
          pool: d.used_by,
        })),
      };
    },
  );
}
