import type { Toolbox } from "../toolbox";
import { registerContainers } from "./containers";
import { registerImages } from "./images";
import { registerProjects } from "./projects";

/** Container Manager: containers, images and Compose projects. */
export function registerContainerTools(tb: Toolbox): void {
  registerContainers(tb);
  registerImages(tb);
  registerProjects(tb);
}
