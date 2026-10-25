import { appendFileSync } from "node:fs";
import type { CallToolResult, McpServer, StandardSchemaWithJSON, ToolCallback } from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { Domain, Permission } from "../permissions";
import type { SynologyClient } from "../synology/client";
import { SynologyError } from "../synology/errors";
import { humanizeTimes } from "./format";

/** What a tool does to the NAS: ro exposes read tools only, rw all of them. */
export type ToolLevel = "read" | "write" | "destructive";

export const isExposed = (permission: Permission, level: ToolLevel) =>
  permission === "rw" || (permission === "ro" && level === "read");

export interface ToolSpec<S extends z.ZodObject> {
  title: string;
  description: string;
  level: ToolLevel;
  input: S;
  /** Calling it twice with the same arguments has no additional effect. */
  idempotent?: boolean;
}

/** Results longer than this are cut so a huge listing doesn't flood the agent's context. */
const MAX_RESULT_CHARS = 80_000;

const SECRET_KEYS = /pass(wd|word)?|secret|token|otp/i;

/** Longer strings (a file written with file_write…) are cut in the audit log. */
const MAX_AUDIT_STRING = 200;

export class AuditLog {
  constructor(private readonly file?: string) {}

  record(tool: string, args: unknown, outcome: "ok" | "error", error?: string, user?: string): void {
    const line = JSON.stringify({ time: new Date().toISOString(), user, tool, args: redact(args), outcome, error });
    console.error(`[audit] ${line}`);
    if (this.file) {
      try {
        appendFileSync(this.file, line + "\n");
      } catch (err) {
        console.error(`[audit] cannot write ${this.file}: ${(err as Error).message}`);
      }
    }
  }
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEYS.test(k) ? "***" : redact(v)]),
    );
  }
  if (typeof value === "string" && value.length > MAX_AUDIT_STRING) {
    return `${value.slice(0, MAX_AUDIT_STRING)}… [${value.length} characters]`;
  }
  return value;
}

export interface ToolboxContext {
  server: McpServer;
  client: SynologyClient;
  /** Permission of each part of the server, from the permissions file. */
  permissions: Record<Domain, Permission>;
  audit: AuditLog;
  /** Who the calls are made for (the signed-in DSM user over HTTP), recorded in the audit log. */
  user?: string;
}

/**
 * Registers tools on the MCP server. Each part of the server gets its own view (forDomain), which hides
 * the tools its permission does not allow.
 */
export class Toolbox {
  constructor(
    private readonly ctx: ToolboxContext,
    readonly domain?: Domain,
    /** Names of the tools exposed, shared by every view. */
    readonly registered: string[] = [],
  ) {}

  get client(): SynologyClient {
    return this.ctx.client;
  }

  /** This part's permission; "off" outside a part, so a tool always belongs to one. */
  get permission(): Permission {
    return this.domain ? this.ctx.permissions[this.domain] : "off";
  }

  forDomain(domain: Domain): Toolbox {
    return new Toolbox(this.ctx, domain, this.registered);
  }

  tool<S extends z.ZodObject>(name: string, spec: ToolSpec<S>, handler: (args: z.output<S>) => Promise<unknown>) {
    if (!isExposed(this.permission, spec.level)) return;
    this.registered.push(name);

    const audited = spec.level !== "read";
    this.ctx.server.registerTool<StandardSchemaWithJSON, S>(
      name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.input,
        annotations: {
          readOnlyHint: spec.level === "read",
          destructiveHint: spec.level === "destructive",
          idempotentHint: spec.idempotent ?? spec.level === "read",
          openWorldHint: false,
        },
      },
      // Cast: the SDK callback type is conditional on S and cannot be resolved while S is generic.
      (async (args: z.output<S>): Promise<CallToolResult> => {
        try {
          const result = await handler(args);
          if (audited) this.ctx.audit.record(name, args, "ok", undefined, this.ctx.user);
          return { content: [{ type: "text", text: format(result) }] };
        } catch (err) {
          const message = errorText(err);
          if (audited) this.ctx.audit.record(name, args, "error", message, this.ctx.user);
          return { isError: true, content: [{ type: "text", text: message }] };
        }
      }) as ToolCallback<S>,
    );
  }
}

function format(result: unknown): string {
  if (result === undefined || result === null) return "OK";
  const text = typeof result === "string" ? result : JSON.stringify(humanizeTimes(result), null, 2);
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n… [truncated, ${text.length} characters in total; narrow the request with limit/offset or a filter]`;
}

function errorText(err: unknown): string {
  if (err instanceof SynologyError) {
    return err.details ? `${err.message}\nDetails: ${JSON.stringify(err.details)}` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
