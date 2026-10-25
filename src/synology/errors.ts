// Error codes from the DSM Web API. Codes below 400 are shared by every API;
// codes from 400 up depend on the API family (they overlap between families).

const COMMON: Record<number, string> = {
  100: "Unknown error",
  101: "Missing or invalid parameter",
  102: "The requested API does not exist",
  103: "The requested method does not exist",
  104: "The requested version does not support this functionality",
  105: "The logged-in session does not have permission",
  106: "Session timeout",
  107: "Session interrupted by duplicate login",
  108: "Failed to upload the file",
  109: "The network connection is unstable or the system is busy",
  110: "The network connection is unstable or the system is busy",
  111: "The network connection is unstable or the system is busy",
  114: "Lost parameters for this API",
  115: "Not allowed to upload a file",
  116: "Not allowed to perform for a demo site",
  117: "The network connection is unstable or the system is busy",
  118: "The network connection is unstable or the system is busy",
  119: "Invalid session",
  120: "Invalid parameter",
  150: "Request source IP does not match the login IP",
};

const AUTH: Record<number, string> = {
  400: "No such account or incorrect password",
  401: "Account disabled",
  402: "Permission denied",
  403: "2-factor authentication code required",
  404: "Failed to authenticate 2-factor authentication code",
  406: "2-factor authentication is enforced for this account",
  407: "Blocked IP source",
  408: "Expired password cannot be changed",
  409: "Expired password",
  410: "Password must be changed",
};

const FILE_STATION: Record<number, string> = {
  400: "Invalid parameter of file operation",
  401: "Unknown error of file operation",
  402: "System is too busy",
  403: "Invalid user does this file operation",
  404: "Invalid group does this file operation",
  405: "Invalid user and group does this file operation",
  406: "Can't get user/group information from the account server",
  407: "Operation not permitted",
  408: "No such file or directory",
  409: "Non-supported file system",
  410: "Failed to connect internet-based file system",
  411: "Read-only file system",
  412: "Filename too long in the non-encrypted file system",
  413: "Filename too long in the encrypted file system",
  414: "File already exists",
  415: "Disk quota exceeded",
  416: "No space left on device",
  417: "Input/output error",
  418: "Illegal name or path",
  419: "Illegal file name",
  420: "Illegal file name on FAT file system",
  421: "Device or resource busy",
  599: "No such task of the file operation",
  900: "Failed to delete file(s) or folder(s)",
  1000: "Failed to copy files/folders",
  1001: "Failed to move files/folders",
  1002: "An error occurred at the destination",
  1003: "The destination already exists and no conflict policy was given",
  1004: "A file cannot overwrite a folder with the same name, or the reverse",
  1006: "Cannot copy/move a name with special characters to a FAT32 file system",
  1007: "Cannot copy/move a file bigger than 4 GB to a FAT32 file system",
  1100: "Failed to create a folder",
  1101: "The parent folder would exceed the maximum number of folders",
  1200: "Failed to rename",
};

/** Codes meaning the session is gone and a fresh login should be attempted. */
export const SESSION_ERROR_CODES = new Set([106, 107, 119]);

export function describeError(api: string, code: number): string {
  const family = api === "SYNO.API.Auth" ? AUTH : api.startsWith("SYNO.FileStation.") ? FILE_STATION : {};
  const message = family[code] ?? COMMON[code] ?? `Error code ${code}`;
  return message + hint(api, code);
}

function hint(api: string, code: number): string {
  if (code === 102 && api.startsWith("SYNO.Docker.")) return " (is Container Manager installed?)";
  if (code === 105) return " (the DSM account probably needs to be in the administrators group)";
  if (code === 3205 && api.startsWith("SYNO.Core.Group")) return " (no such group: create it in Control Panel > Group)";
  if (api === "SYNO.API.Auth" && code === 403) return " (run `bun run device-token <otp>` to store a device token)";
  if (api === "SYNO.API.Auth" && code === 406)
    return " (sign in to DSM once with this account to set up 2FA, then run `bun run device-token <otp>`)";
  return "";
}

export class SynologyError extends Error {
  constructor(
    readonly api: string,
    readonly method: string,
    readonly code: number,
    readonly details?: unknown,
  ) {
    super(`${api}.${method} failed: ${describeError(api, code)} [code ${code}]`);
    this.name = "SynologyError";
  }
}
