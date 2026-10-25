import type { Toolbox } from "../toolbox";
import { registerPermissions } from "./permissions";
import { registerShares } from "./shares";

/** Shared folders and who can access them. */
export function registerShareTools(tb: Toolbox): void {
  registerShares(tb);
  registerPermissions(tb);
}
