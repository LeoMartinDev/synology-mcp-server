import { z } from "zod";

export const SHARE = "SYNO.Core.Share";

export const shareName = z.string().min(1).describe("Shared folder name, e.g. docker (not a path)");
