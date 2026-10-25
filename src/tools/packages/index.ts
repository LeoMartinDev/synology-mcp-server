import { z } from "zod";
import type { Toolbox } from "../toolbox";

const PACKAGE = "SYNO.Core.Package";

const packageId = z.string().min(1).describe("Package id as returned by package_list, e.g. DownloadStation");

interface PackageList {
  packages: {
    id: string;
    name: string;
    version: string;
    additional?: {
      status?: string;
      startable?: boolean;
      install_type?: string;
      updated_at?: string;
      dependent_packages?: Record<string, unknown> | null;
    };
  }[];
  total: number;
}

/** DSM packages (Package Center): what is installed, running, and what it needs. */
export function registerPackageTools(tb: Toolbox): void {
  const { client } = tb;

  tb.tool(
    "package_list",
    {
      title: "List packages",
      description:
        "List the installed DSM packages with their version, status (running/stop) and the packages they depend on. System packages come with DSM and cannot be removed.",
      level: "read",
      input: z.object({}),
    },
    async () => {
      const { packages } = await client.call<PackageList>(PACKAGE, "list", {
        additional: ["status", "startable", "install_type", "updated_at", "dependent_packages"],
      });
      return packages.map(({ id, name, version, additional: a = {} }) => ({
        id,
        name,
        version,
        status: a.status,
        startable: a.startable,
        system: a.install_type === "system",
        updated_at: a.updated_at,
        depends_on: Object.keys(a.dependent_packages ?? {}),
      }));
    },
  );

  tb.tool(
    "package_start",
    {
      title: "Start a package",
      description: "Start a stopped package. Only packages marked startable by package_list can be started or stopped.",
      level: "write",
      idempotent: true,
      input: z.object({ id: packageId }),
    },
    ({ id }) => client.call(`${PACKAGE}.Control`, "start", { id }),
  );

  tb.tool(
    "package_stop",
    {
      title: "Stop a package",
      description: "Stop a running package; packages that depend on it may stop working.",
      level: "write",
      idempotent: true,
      input: z.object({ id: packageId }),
    },
    ({ id }) => client.call(`${PACKAGE}.Control`, "stop", { id }),
  );

  tb.tool(
    "package_uninstall",
    {
      title: "Uninstall a package",
      description:
        "Uninstall a package. Depending on the package, its settings and database are removed with it; its shared folders are kept. Irreversible.",
      level: "destructive",
      input: z.object({ id: packageId }),
    },
    ({ id }) => client.call(`${PACKAGE}.Uninstallation`, "uninstall", { id }),
  );
}
