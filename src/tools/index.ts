import { registerContainerTools } from "./containers";
import { registerDiscoveryTools } from "./discovery";
import { registerFileTools } from "./files";
import { registerPackageTools } from "./packages";
import { registerShareTools } from "./shares";
import { registerStorageTools } from "./storage";
import { registerSystemTools } from "./system";
import type { Toolbox } from "./toolbox";
import { registerUserTools } from "./users";

/** Each part registers through its own view of the toolbox, which applies that part's permission. */
export function registerAllTools(tb: Toolbox): void {
  registerSystemTools(tb.forDomain("system"));
  registerStorageTools(tb.forDomain("storage"));
  registerPackageTools(tb.forDomain("packages"));
  registerContainerTools(tb.forDomain("containers"));
  registerFileTools(tb.forDomain("files"));
  registerShareTools(tb.forDomain("shares"));
  registerUserTools(tb.forDomain("users"));
  registerDiscoveryTools(tb.forDomain("discovery"));
}
