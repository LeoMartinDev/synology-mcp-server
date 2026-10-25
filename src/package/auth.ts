import { createHash } from "node:crypto";

/** Who is calling the DSM app's API: a DSM administrator, or why not. */
export type AdminCheck = { user: string } | { refused: "signed-out" | "not-admin" };

export interface AdminAuthenticator {
  check(request: Request, remoteIp: string): Promise<AdminCheck>;
}

/** Runs a program and returns its standard output, or undefined when it fails. */
export type Runner = (cmd: string[], env: Record<string, string>) => Promise<string | undefined>;

const runProgram: Runner = async (cmd, env) => {
  try {
    const proc = Bun.spawn(cmd, { env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? out : undefined;
  } catch {
    return undefined;
  }
};

/** Where DSM 7 keeps the program that tells which user a browser session belongs to. */
const AUTHENTICATE_CGI = ["/usr/syno/synoman/webman/modules/authenticate.cgi", "/usr/syno/synoman/webman/authenticate.cgi"];
const PATH = "/usr/syno/bin:/usr/syno/sbin:/usr/bin:/bin:/usr/sbin:/sbin";

/** DSM user names never contain whitespace or start with a dash (which `id` would read as an option). */
const USER_NAME = /^[^\s-][^\s]{0,63}$/;
const CACHE_MS = 30_000;

/**
 * Checks the DSM session of a request coming through DSM's own web server: its session cookie and its
 * SynoToken (which DSM requires, so another site cannot make the browser call this API), then that the
 * user is in the administrators group. Answers are cached briefly, the app calling several routes at once.
 */
export class DsmSessionAuth implements AdminAuthenticator {
  private readonly cache = new Map<string, { result: AdminCheck; expiresAt: number }>();

  constructor(
    private readonly run: Runner = runProgram,
    private readonly cgi = AUTHENTICATE_CGI.find((path) => Bun.file(path).size > 0) ?? AUTHENTICATE_CGI[0]!,
    private readonly now = Date.now,
  ) {}

  async check(request: Request, remoteIp: string): Promise<AdminCheck> {
    const cookie = request.headers.get("cookie") ?? "";
    const token = request.headers.get("x-syno-token") ?? "";
    if (!cookie || !token) return { refused: "signed-out" };

    const key = createHash("sha256").update(`${cookie}\n${token}\n${remoteIp}`).digest("hex");
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.result;

    const result = await this.lookUp(request, cookie, token, remoteIp);
    for (const [k, v] of this.cache) if (v.expiresAt <= this.now()) this.cache.delete(k);
    this.cache.set(key, { result, expiresAt: this.now() + CACHE_MS });
    return result;
  }

  private async lookUp(request: Request, cookie: string, token: string, remoteIp: string): Promise<AdminCheck> {
    // authenticate.cgi reads the request from a CGI environment and prints the user name, or nothing.
    const url = new URL(request.url);
    const output = await this.run([this.cgi], {
      PATH,
      GATEWAY_INTERFACE: "CGI/1.1",
      REQUEST_METHOD: "GET",
      SERVER_PROTOCOL: "HTTP/1.1",
      SERVER_ADDR: "127.0.0.1",
      QUERY_STRING: "",
      HTTP_COOKIE: cookie,
      HTTP_HOST: request.headers.get("host") ?? url.host,
      HTTP_USER_AGENT: request.headers.get("user-agent") ?? "",
      HTTP_X_SYNO_TOKEN: token,
      REMOTE_ADDR: remoteIp,
    });
    const user = output?.trim() ?? "";
    if (!USER_NAME.test(user)) return { refused: "signed-out" };

    const groups = await this.run(["id", "-Gn", user], { PATH });
    return groups?.split(/\s+/).includes("administrators") ? { user } : { refused: "not-admin" };
  }
}
