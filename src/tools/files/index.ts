import type { Toolbox } from "../toolbox";
import { registerBrowseTools } from "./browse";
import { registerContentTools } from "./content";
import { registerOperationTools } from "./operations";

/** File Station: browsing, searching, reading and writing files, file operations. */
export function registerFileTools(tb: Toolbox): void {
  registerBrowseTools(tb);
  registerContentTools(tb);
  registerOperationTools(tb);
}
