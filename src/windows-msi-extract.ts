import { copyFile, lstat, mkdir, readdir } from 'node:fs/promises'
import { isAbsolute, join, win32 } from 'node:path'
import { performance } from 'node:perf_hooks'
import { execFileText } from './exec-file.js'

/** Windows extraction stage reported without subprocess output or private paths. */
export type WindowsMsiExtractionStage = 'tools' | 'archive' | 'database' | 'cabinet' | 'file'

interface SafeCommandDetails {
  readonly code?: number | string | null
  readonly signal?: string | null
  readonly killed?: boolean
  readonly deadlineMs?: number
}

/** A failed read-only MSI extraction; causes deliberately exclude raw command arguments. */
export class WindowsMsiExtractionError extends Error {
  readonly signal: string | null | undefined
  readonly killed: boolean | undefined
  readonly deadlineMs: number | undefined

  constructor(readonly stage: WindowsMsiExtractionStage, readonly elapsedMs: number, readonly nativeCode?: number | string | null,
    details: SafeCommandDetails = {}) {
    const fields = Object.entries({ ...details, ...(nativeCode === undefined ? {} : { code: nativeCode }) })
      .map(([key, value]) => `${key}=${String(value)}`).join(', ')
    super(`cpolar_extract_${stage}_failed`, { cause: Object.assign(new Error(
      `Windows cpolar ${stage} extraction failed after ${String(elapsedMs)} ms${fields === '' ? '' : ` (${fields})`}`,
    ), details) })
    this.name = 'WindowsMsiExtractionError'
    this.signal = details.signal
    this.killed = details.killed
    this.deadlineMs = details.deadlineMs
  }
}

// MsiOpenDatabase READONLY accesses tables, never an installation/action sequence.
// All handles are closed on this synchronous reader's thread. Media maps File.Sequence
// to an embedded _Streams CAB; the cabinet reader extracts only the selected File key.
const READ_MSI_CABINET = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]

public sealed class DshMsiEntry {
  public string Member;
  public int Bytes;
  public long CabinetBytes;
}
public static class DshReadOnlyMsi {
  [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  private static extern uint MsiOpenDatabaseW(string path, IntPtr mode, out uint database);
  [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  private static extern uint MsiDatabaseOpenViewW(uint database, string query, out uint view);
  [DllImport("msi.dll", ExactSpelling = true)]
  private static extern uint MsiViewExecute(uint view, uint parameters);
  [DllImport("msi.dll", ExactSpelling = true)]
  private static extern uint MsiViewFetch(uint view, out uint record);
  [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  private static extern uint MsiRecordGetStringW(uint record, uint field, StringBuilder value, ref uint size);
  [DllImport("msi.dll", ExactSpelling = true)]
  private static extern int MsiRecordGetInteger(uint record, uint field);
  [DllImport("msi.dll", ExactSpelling = true)]
  private static extern uint MsiRecordReadStream(uint record, uint field, byte[] buffer, ref uint size);
  [DllImport("msi.dll", ExactSpelling = true)]
  private static extern uint MsiRecordDataSize(uint record, uint field);
  [DllImport("msi.dll", ExactSpelling = true)]
  private static extern uint MsiCreateRecord(uint fields);
  [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  private static extern uint MsiRecordSetStringW(uint record, uint field, string value);
  [DllImport("msi.dll", ExactSpelling = true)]
  private static extern uint MsiCloseHandle(uint handle);

  private static void Check(uint result) {
    if (result != 0) throw new InvalidOperationException("MSI_" + result);
  }
  private static string Text(uint record, uint field) {
    uint count = 512;
    var buffer = new StringBuilder((int)count + 1);
    Check(MsiRecordGetStringW(record, field, buffer, ref count));
    return buffer.ToString();
  }
  private static uint Query(uint database, string sql, uint parameters) {
    uint view = 0;
    Check(MsiDatabaseOpenViewW(database, sql, out view));
    try { Check(MsiViewExecute(view, parameters)); return view; }
    catch { MsiCloseHandle(view); throw; }
  }
  private static bool Next(uint view, out uint record) {
    uint result = MsiViewFetch(view, out record);
    if (result == 259) return false;
    Check(result);
    return record != 0;
  }
  public static DshMsiEntry Read(string msi, string output, string wanted, int expectedBytes) {
    uint database = 0;
    Check(MsiOpenDatabaseW(msi, IntPtr.Zero, out database));
    try {
      string member = null;
      int sequence = 0;
      uint view = Query(database, "SELECT File, FileName, FileSize, Sequence FROM File", 0);
      try {
        int rows = 0;
        uint record;
        while (Next(view, out record)) {
          try {
            if (++rows > 4096) throw new InvalidDataException("FILE_ROWS_LIMIT");
            string filename = Text(record, 2);
            string[] names = filename.Split('|');
            if (!String.Equals(names[names.Length - 1], wanted, StringComparison.OrdinalIgnoreCase)) continue;
            if (member != null) throw new InvalidDataException("FILE_AMBIGUOUS");
            member = Text(record, 1);
            sequence = MsiRecordGetInteger(record, 4);
            if (!Regex.IsMatch(member, @"\A[A-Za-z_][A-Za-z0-9_.]{0,71}\z") || member.Contains("..")
              || sequence < 1 || MsiRecordGetInteger(record, 3) != expectedBytes) {
              throw new InvalidDataException("FILE_METADATA_INVALID");
            }
          } finally { MsiCloseHandle(record); }
        }
      } finally { MsiCloseHandle(view); }
      if (member == null) throw new InvalidDataException("FILE_MISSING");
      string cabinet = null;
      int lowerSequence = 0;
      view = Query(database, "SELECT LastSequence, Cabinet FROM Media ORDER BY DiskId", 0);
      try {
        int rows = 0;
        uint record;
        while (Next(view, out record)) {
          try {
            if (++rows > 128) throw new InvalidDataException("MEDIA_ROWS_LIMIT");
            int upperSequence = MsiRecordGetInteger(record, 1);
            if (upperSequence < lowerSequence) throw new InvalidDataException("MEDIA_SEQUENCE_INVALID");
            if (sequence > lowerSequence && sequence <= upperSequence) cabinet = Text(record, 2);
            lowerSequence = upperSequence;
          } finally { MsiCloseHandle(record); }
        }
      } finally { MsiCloseHandle(view); }
      if (cabinet == null || !Regex.IsMatch(cabinet, @"\A#[A-Za-z_][A-Za-z0-9_.-]{0,61}\z")) {
        throw new InvalidDataException("EMBEDDED_CABINET_MISSING");
      }
      uint parameter = MsiCreateRecord(1);
      if (parameter == 0) throw new InvalidOperationException("RECORD_CREATE_FAILED");
      try {
        Check(MsiRecordSetStringW(parameter, 1, cabinet.Substring(1)));
        view = Query(database, "SELECT Data FROM _Streams WHERE Name = ?", parameter);
        try {
          uint record;
          if (!Next(view, out record)) throw new InvalidDataException("CABINET_STREAM_MISSING");
          try {
            uint bytes = MsiRecordDataSize(record, 1);
            if (bytes < 36 || bytes > new FileInfo(msi).Length || bytes > 33554432) {
              throw new InvalidDataException("CABINET_SIZE_INVALID");
            }
            using (var stream = new FileStream(output, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
              byte[] buffer = new byte[65536];
              long total = 0;
              while (true) {
                uint count = (uint)buffer.Length;
                Check(MsiRecordReadStream(record, 1, buffer, ref count));
                if (count == 0) break;
                total += count;
                if (count > buffer.Length || total > bytes) throw new InvalidDataException("CABINET_STREAM_OVERFLOW");
                stream.Write(buffer, 0, (int)count);
              }
              if (total != bytes) throw new InvalidDataException("CABINET_STREAM_TRUNCATED");
            }
            return new DshMsiEntry { Member = member, Bytes = expectedBytes, CabinetBytes = bytes };
          } finally { MsiCloseHandle(record); }
        } finally { MsiCloseHandle(view); }
      } finally { MsiCloseHandle(parameter); }
    } finally { MsiCloseHandle(database); }
  }
}
'@
  $result = [DshReadOnlyMsi]::Read($env:DSH_MSI_SOURCE, $env:DSH_MSI_CABINET, $env:DSH_MSI_BINARY, [int]$env:DSH_MSI_BYTES)
  $result | ConvertTo-Json -Compress
} catch {
  [Console]::Error.WriteLine('DSH_MSI_READ_FAILED')
  exit 1
}
`

const READ_MSI_ZIP = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($env:DSH_MSI_ZIP)
  try {
    if ($zip.Entries.Count -lt 1 -or $zip.Entries.Count -gt 128) { throw 'ZIP_ENTRIES_LIMIT' }
    $selected = $null
    [long]$total = 0
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName.Replace('\', '/')
      $segments = $name.TrimEnd('/').Split('/')
      if ($name.StartsWith('/') -or $name.Contains(':') -or $segments -contains '..' -or $segments -contains '.' -or $segments -contains '') { throw 'ZIP_PATH_INVALID' }
      if (($entry.ExternalAttributes -band 0x400) -ne 0 -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'ZIP_LINK_INVALID' }
      if ($entry.Length -lt 0 -or $entry.Length -gt (33554432 - $total)) { throw 'ZIP_SIZE_LIMIT' }
      $total += $entry.Length
      if (-not $name.EndsWith('/') -and $name.EndsWith('.msi', [System.StringComparison]::OrdinalIgnoreCase)) {
        if ($null -ne $selected -or $entry.Length -lt 1) { throw 'ZIP_MSI_INVALID' }
        $selected = $entry
      }
    }
    if ($null -eq $selected) { throw 'ZIP_MSI_MISSING' }
    if (([System.IO.File]::GetAttributes([System.IO.Path]::GetDirectoryName($env:DSH_MSI_OUTPUT)) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'ZIP_PARENT_INVALID' }
    $zipEntryStream = $selected.Open()
    try {
      $zipMsiOutput = [System.IO.File]::Open($env:DSH_MSI_OUTPUT, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
      try {
        $buffer = New-Object byte[] 65536
        [long]$written = 0
        while (($count = $zipEntryStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
          $written += $count
          if ($written -gt $selected.Length -or $written -gt 33554432) { throw 'ZIP_STREAM_OVERFLOW' }
          $zipMsiOutput.Write($buffer, 0, $count)
        }
        if ($written -ne $selected.Length) { throw 'ZIP_STREAM_TRUNCATED' }
      } finally { $zipMsiOutput.Dispose() }
    } finally { $zipEntryStream.Dispose() }
  } finally { $zip.Dispose() }
  [Console]::WriteLine('DSH_MSI_ZIP_READY')
} catch {
  [Console]::Error.WriteLine('DSH_MSI_ZIP_FAILED')
  exit 1
}
`

// SetupIterateCabinetW notifications and FILE_IN_CABINET_INFO_W follow the Windows SDK:
// https://learn.microsoft.com/windows/win32/api/setupapi/nf-setupapi-setupiteratecabinetw
// https://learn.microsoft.com/windows/win32/api/setupapi/ns-setupapi-file_in_cabinet_info_w
// The callback writes only FullTargetName's inline UTF-16 buffer, never the native name pointer.
const READ_MSI_CABINET_FILE = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]

public static class DshReadOnlyCabinet {
  private const uint CabinetInfo = 0x10;
  private const uint FileInCabinet = 0x11;
  private const uint NeedNewCabinet = 0x12;
  private const uint FileExtracted = 0x13;
  private const uint FileopAbort = 0;
  private const uint FileopDoit = 1;
  private const uint FileopSkip = 2;
  private const uint InvalidData = 13;
  private const int MaxPath = 260;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct FileInCabinetInfo {
    public IntPtr NameInCabinet;
    public uint FileSize;
    public uint Win32Error;
    public ushort DosDate;
    public ushort DosTime;
    public ushort DosAttribs;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = MaxPath)]
    public string FullTargetName;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct FilePaths {
    public IntPtr Target;
    public IntPtr Source;
    public uint Win32Error;
    public uint Flags;
  }
  [UnmanagedFunctionPointer(CallingConvention.Winapi)]
  private delegate uint CabinetCallback(IntPtr context, uint notification, IntPtr param1, IntPtr param2);
  [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool SetupIterateCabinetW(string cabinet, uint reserved, CabinetCallback callback, IntPtr context);

  public static void Extract(string cabinet, string directory, string wanted, int expectedBytes) {
    if (!Regex.IsMatch(wanted, @"\A[A-Za-z_][A-Za-z0-9_.]{0,71}\z") || wanted.Contains("..")
      || expectedBytes < 1 || !Path.IsPathRooted(cabinet) || !Path.IsPathRooted(directory)) {
      throw new InvalidDataException("CABINET_INPUT_INVALID");
    }
    if (!Directory.Exists(directory) || (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0
      || Directory.GetFileSystemEntries(directory).Length != 0) {
      throw new InvalidDataException("CABINET_DESTINATION_INVALID");
    }
    string target = Path.GetFullPath(Path.Combine(directory, wanted));
    string source = Path.GetFullPath(cabinet);
    if (target.Length >= MaxPath || (File.GetAttributes(source) & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0) {
      throw new InvalidDataException("CABINET_PATH_INVALID");
    }
    int targetOffset = Marshal.OffsetOf(typeof(FileInCabinetInfo), "FullTargetName").ToInt32();
    if (targetOffset != IntPtr.Size + 14) throw new InvalidDataException("CABINET_ABI_INVALID");
    int matched = 0;
    int entries = 0;
    int cabinets = 0;
    bool completed = false;
    bool callbackFailed = false;
    CabinetCallback callback = delegate(IntPtr context, uint notification, IntPtr param1, IntPtr param2) {
      try {
        if (notification == CabinetInfo) {
          if (++cabinets > 1) throw new InvalidDataException("CABINET_CONTINUATION_INVALID");
          return 0;
        }
        if (notification == NeedNewCabinet) throw new InvalidDataException("CABINET_CONTINUATION_INVALID");
        if (notification == FileInCabinet) {
          if (++entries > 4096 || param1 == IntPtr.Zero) throw new InvalidDataException("CABINET_ENTRIES_INVALID");
          var entry = (FileInCabinetInfo)Marshal.PtrToStructure(param1, typeof(FileInCabinetInfo));
          string name = Marshal.PtrToStringUni(entry.NameInCabinet);
          if (!String.Equals(name, wanted, StringComparison.Ordinal)) return FileopSkip;
          if (++matched != 1 || entry.FileSize != (uint)expectedBytes || entry.Win32Error != 0
            || (entry.DosAttribs & 0x410) != 0 || File.Exists(target) || Directory.Exists(target)
            || (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) {
            throw new InvalidDataException("CABINET_MEMBER_INVALID");
          }
          char[] path = new char[MaxPath];
          target.CopyTo(0, path, 0, target.Length);
          Marshal.Copy(path, 0, IntPtr.Add(param1, targetOffset), MaxPath);
          return FileopDoit;
        }
        if (notification == FileExtracted) {
          if (param1 == IntPtr.Zero) throw new InvalidDataException("CABINET_RESULT_INVALID");
          var result = (FilePaths)Marshal.PtrToStructure(param1, typeof(FilePaths));
          if (completed || matched != 1 || result.Win32Error != 0
            || !String.Equals(Marshal.PtrToStringUni(result.Target), target, StringComparison.OrdinalIgnoreCase)
            || !String.Equals(Marshal.PtrToStringUni(result.Source), source, StringComparison.OrdinalIgnoreCase)) {
            throw new InvalidDataException("CABINET_RESULT_INVALID");
          }
          completed = true;
          return 0;
        }
        throw new InvalidDataException("CABINET_NOTIFICATION_INVALID");
      } catch (Exception) {
        callbackFailed = true;
        return notification == FileInCabinet ? FileopAbort : InvalidData;
      }
    };
    bool success = SetupIterateCabinetW(source, 0, callback, IntPtr.Zero);
    int error = success ? 0 : Marshal.GetLastWin32Error();
    GC.KeepAlive(callback);
    if (callbackFailed || !success || matched != 1 || !completed) {
      throw new InvalidDataException("CABINET_EXTRACTION_FAILED_" + error);
    }
    if (!File.Exists(target) || (File.GetAttributes(target) & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0
      || new FileInfo(target).Length != expectedBytes || Directory.GetFileSystemEntries(directory).Length != 1) {
      throw new InvalidDataException("CABINET_OUTPUT_INVALID");
    }
  }
}
'@
  [DshReadOnlyCabinet]::Extract($env:DSH_CAB_SOURCE, $env:DSH_CAB_DESTINATION, $env:DSH_CAB_MEMBER, [int]$env:DSH_CAB_BYTES)
  [Console]::WriteLine('DSH_MSI_CABINET_READY')
} catch {
  [Console]::Error.WriteLine('DSH_MSI_CABINET_FAILED')
  exit 1
}
`

/** Resolve Windows built-in tools without inheriting a PATH-selected replacement. */
export function cpolarWindowsSystemTool(name: 'powershell.exe' | 'tar.exe'): string {
  const root = process.env.SystemRoot ?? process.env.WINDIR
  if (root === undefined || !win32.isAbsolute(root) || root.startsWith('\\\\')) {
    throw new WindowsMsiExtractionError('tools', 0, 'SYSTEM_ROOT_UNAVAILABLE')
  }
  return name === 'powershell.exe'
    ? win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', name)
    : win32.join(root, 'System32', name)
}

function safeCommandDetails(error: unknown): SafeCommandDetails {
  if (error === null || typeof error !== 'object') return {}
  let descriptors: PropertyDescriptorMap
  try { descriptors = Object.getOwnPropertyDescriptors(error) } catch (_error) { return {} }
  const code: unknown = descriptors.code?.value
  const signal: unknown = descriptors.signal?.value
  const killed: unknown = descriptors.killed?.value
  const deadlineMs: unknown = descriptors.deadlineMs?.value
  return {
    ...(code === null || (typeof code === 'number' && Number.isSafeInteger(code))
      || (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code)) ? { code } : {}),
    ...(signal === null || (typeof signal === 'string' && /^SIG[A-Z0-9]{1,16}$/u.test(signal)) ? { signal } : {}),
    ...(typeof killed === 'boolean' ? { killed } : {}),
    ...(typeof deadlineMs === 'number' && Number.isSafeInteger(deadlineMs) && deadlineMs >= 0 ? { deadlineMs } : {}),
  }
}

/** Execute one system extraction tool with a fixed deadline; distinguish an unavailable executable from a rejected artifact. */
export async function runCpolarWindowsTool(name: 'powershell.exe' | 'tar.exe', args: readonly string[],
  env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  const started = performance.now()
  try {
    return await execFileText(cpolarWindowsSystemTool(name), args, {
      windowsHide: true, timeout: 120_000, maxBuffer: 16_384, ...(env === undefined ? {} : { env }),
    })
  } catch (error) {
    if (error instanceof WindowsMsiExtractionError) throw error
    const details = { ...safeCommandDetails(error), deadlineMs: 120_000 }
    if (details.code === 'ENOENT') throw new WindowsMsiExtractionError('tools', Math.max(0, Math.round(performance.now() - started)), details.code, details)
    throw Object.assign(new Error('Windows cpolar extraction command failed'), details)
  }
}

/** Classify extraction failures without retaining raw command output, arguments or paths. */
export async function cpolarWindowsExtractionStep<T>(name: WindowsMsiExtractionStage, operation: () => Promise<T>): Promise<T> {
  const started = performance.now()
  try { return await operation() } catch (error) {
    if (error instanceof WindowsMsiExtractionError) throw error
    const details = safeCommandDetails(error)
    throw new WindowsMsiExtractionError(name, Math.max(0, Math.round(performance.now() - started)), details.code, details)
  }
}

/**
 * Read the verified Windows ZIP into a fixed MSI file using Unicode-aware .NET paths, without installer actions.
 * @param archive - Absolute path to the pinned, size/hash-verified ZIP.
 * @param destination - Owned, non-linked staging directory for a new installer.msi.
 * @returns Absolute path to the extracted ordinary MSI file.
 */
export async function extractWindowsMsiArchive(archive: string, destination: string): Promise<string> {
  return cpolarWindowsExtractionStep('archive', async () => {
    if (process.platform !== 'win32' || !isAbsolute(archive) || !isAbsolute(destination)) throw new Error('invalid ZIP input')
    const parent = await lstat(destination)
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('invalid ZIP destination')
    const msi = join(destination, 'installer.msi')
    const { stdout } = await runCpolarWindowsTool('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(READ_MSI_ZIP, 'utf16le').toString('base64'),
    ], { ...process.env, DSH_MSI_ZIP: archive, DSH_MSI_OUTPUT: msi })
    if (stdout.trim() !== 'DSH_MSI_ZIP_READY') throw new Error('invalid ZIP reader output')
    const info = await lstat(msi)
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 33_554_432) throw new Error('invalid extracted MSI')
    return msi
  })
}

/** Read one executable from an embedded MSI cabinet; never execute installer actions or alter system installation state. */
export async function extractWindowsMsiBinary(msi: string, destination: string, executableName: string, expectedBytes: number): Promise<void> {
  if (process.platform !== 'win32' || !isAbsolute(msi) || !isAbsolute(destination)
    || !/^[A-Za-z0-9_-]+\.exe$/u.test(executableName) || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1) {
    throw new WindowsMsiExtractionError('file', 0, 'INPUT_INVALID')
  }
  const cabinet = join(destination, 'component.cab')
  const extracted = join(destination, 'cabinet')
  const metadata = await cpolarWindowsExtractionStep('database', async () => {
    const { stdout } = await runCpolarWindowsTool('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(READ_MSI_CABINET, 'utf16le').toString('base64'),
    ], { ...process.env, DSH_MSI_SOURCE: msi, DSH_MSI_CABINET: cabinet, DSH_MSI_BINARY: executableName, DSH_MSI_BYTES: String(expectedBytes) })
    const value: unknown = JSON.parse(stdout.trim())
    if (value === null || typeof value !== 'object' || !('Member' in value) || typeof value.Member !== 'string'
      || !/^[A-Za-z_][A-Za-z0-9_.]{0,71}$/u.test(value.Member) || value.Member.includes('..')
      || !('Bytes' in value) || value.Bytes !== expectedBytes || !('CabinetBytes' in value)
      || typeof value.CabinetBytes !== 'number' || !Number.isSafeInteger(value.CabinetBytes)
      || value.CabinetBytes < 36 || value.CabinetBytes > 33_554_432) throw new Error('invalid cabinet metadata')
    const info = await lstat(cabinet)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== value.CabinetBytes) throw new Error('invalid cabinet file')
    return { member: value.Member, cabinetBytes: value.CabinetBytes }
  })
  await cpolarWindowsExtractionStep('cabinet', async () => {
    await mkdir(extracted, { mode: 0o700 })
    const { stdout } = await runCpolarWindowsTool('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(READ_MSI_CABINET_FILE, 'utf16le').toString('base64'),
    ], { ...process.env, DSH_CAB_SOURCE: cabinet, DSH_CAB_DESTINATION: extracted,
      DSH_CAB_MEMBER: metadata.member, DSH_CAB_BYTES: String(expectedBytes) })
    if (stdout.trim() !== 'DSH_MSI_CABINET_READY') throw new Error('invalid cabinet reader output')
  })
  await cpolarWindowsExtractionStep('file', async () => {
    const entries = await readdir(extracted)
    if (entries.length !== 1 || entries[0] !== metadata.member) throw new Error('unexpected cabinet members')
    const binary = join(extracted, metadata.member)
    const info = await lstat(binary)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== expectedBytes) throw new Error('invalid extracted binary')
    await copyFile(binary, join(destination, executableName))
  })
}
