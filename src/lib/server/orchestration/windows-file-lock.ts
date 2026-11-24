import { mkdirSync } from "node:fs";
import { dirname, toNamespacedPath } from "node:path";

const invalidHandle = 0xffff_ffff_ffff_ffffn;
const sharingViolation = 32;
const fileAttributeTagInfo = 9;
const fileAttributeDirectoryOrReparsePoint = 0x10 | 0x400;

interface WindowsLockApi {
  readonly CreateFileW: (path: Buffer, access: number, share: number, security: null, disposition: number, flags: number, template: null) => bigint;
  readonly GetLastError: () => number;
  readonly GetFileType: (handle: bigint) => number;
  readonly GetFileInformationByHandleEx: (handle: bigint, infoClass: number, info: Buffer, size: number) => number;
  readonly CloseHandle: (handle: bigint) => number;
}

// The OS releases the exclusive handle even if the process crashes. Leave the
// file in place: deleting a lock file can let two writers lock different files.
export const lockWindowsFileHandle = (path: string, api: WindowsLockApi): (() => void) | "busy" => {
  const name = Buffer.from(path + "\0", "utf16le");
  // GENERIC_READ, no sharing, OPEN_ALWAYS, FILE_FLAG_OPEN_REPARSE_POINT.
  const handle = api.CreateFileW(name, 0x80000000, 0, null, 4, 0x00200000, null);

  if (handle === invalidHandle) {
    if (api.GetLastError() === sharingViolation) return "busy";
    throw new Error("Windows could not open the lock file");
  }

  const close = () => {
    if (api.CloseHandle(handle) === 0) throw new Error("Windows could not close the lock file");
  };

  const info = Buffer.alloc(8);

  try {
    if (api.GetFileType(handle) !== 1 || !api.GetFileInformationByHandleEx(handle, fileAttributeTagInfo, info, info.length)
      || (info.readUInt32LE(0) & fileAttributeDirectoryOrReparsePoint) !== 0) throw new Error("Unsafe lock file");
  } catch (error) {
    close();
    throw error;
  }

  return close;
};

export const acquireWindowsLock = (path: string): (() => void) | "busy" => {
  if (process.arch !== "x64") throw new Error("Unsupported Windows lock ABI");
  // SAFETY: Windows x64 HANDLEs are 64-bit values; BOOL and DWORD are 32 bits.
  const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
  const { ptr, u32, u64, i32 } = FFIType;

  const library = dlopen("kernel32.dll", {
    CreateFileW: { args: [ptr, u32, u32, ptr, u32, u32, ptr], returns: u64 },
    GetLastError: { args: [], returns: u32 },
    GetFileType: { args: [u64], returns: u32 },
    GetFileInformationByHandleEx: { args: [u64, i32, ptr, u32], returns: i32 },
    CloseHandle: { args: [u64], returns: i32 },
  });

  try {
    mkdirSync(dirname(path), { recursive: true });
    const result = lockWindowsFileHandle(toNamespacedPath(path), library.symbols);

    if (result === "busy") {
      library.close();

      return result;
    }

    return () => { try { result(); } finally { library.close(); } };
  } catch (error) {
    library.close();
    throw error;
  }
};
