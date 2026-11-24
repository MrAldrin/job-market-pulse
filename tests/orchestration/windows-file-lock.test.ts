import { expect, test, vi } from "vitest";
import { lockWindowsFileHandle } from "../../src/lib/server/orchestration/windows-file-lock.ts";

const fake = () => ({
  CreateFileW: vi.fn(() => 123n),
  GetLastError: vi.fn(() => 0),
  GetFileType: vi.fn(() => 1),
  GetFileInformationByHandleEx: vi.fn((_handle: bigint, _class: number, _info: Buffer) => 1),
  CloseHandle: vi.fn(() => 1),
});

const path = String.raw`C:\Users\Example\AppData\Local\Østfold\.writer.lock`;

test("the Windows lock opens a wide nonsharing handle and keeps the file on release", () => {
  const api = fake();
  const release = lockWindowsFileHandle(path, api);

  expect(api.CreateFileW).toHaveBeenCalledWith(Buffer.from(path + "\0", "utf16le"), 0x80000000, 0, null, 4, 0x00200000, null);
  expect(api.GetFileInformationByHandleEx).toHaveBeenCalledWith(123n, 9, Buffer.alloc(8), 8);
  expect(api.CloseHandle).not.toHaveBeenCalled();

  if (release === "busy") throw new Error("Expected a lock handle");
  release();
  expect(api.CloseHandle).toHaveBeenCalledExactlyOnceWith(123n);
});

test("only a Windows sharing violation reports lock contention", () => {
  const api = fake();
  api.CreateFileW.mockReturnValue(0xffff_ffff_ffff_ffffn);
  api.GetLastError.mockReturnValueOnce(32).mockReturnValueOnce(5);
  expect(lockWindowsFileHandle(path, api)).toBe("busy");
  expect(() => lockWindowsFileHandle(path, api)).toThrow("Windows could not open the lock file");
  expect(api.CloseHandle).not.toHaveBeenCalled();
});

test.each([0x10, 0x400])("rejects unsafe Windows file attributes %i and closes the handle", (attributes) => {
  const api = fake();
  api.GetFileInformationByHandleEx.mockImplementation((_handle, _class, info) => {
    info.writeUInt32LE(attributes, 0);

    return 1;
  });
  expect(() => lockWindowsFileHandle(path, api)).toThrow("Unsafe lock file");
  expect(api.CloseHandle).toHaveBeenCalledExactlyOnceWith(123n);
});
