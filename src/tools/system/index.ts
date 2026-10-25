import type { Toolbox } from "../toolbox";
import { registerActivityTools } from "./activity";
import { registerPowerTools } from "./power";
import { registerStatusTools } from "./status";

/** The NAS itself: state, resources, updates, logs, connections, power. */
export function registerSystemTools(tb: Toolbox): void {
  registerStatusTools(tb);
  registerActivityTools(tb);
  registerPowerTools(tb);
}
