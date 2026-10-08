param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$ArgumentsBase64,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
)

$ErrorActionPreference = 'Stop'
# 参数按 JSON 数据传入，不解释命令文本。 / Arguments are JSON data, never shell command text.
$stepArguments = [string[]](ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgumentsBase64))))
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class TiangZTestStepJob {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo {
        public uint cb;
        public string reserved, desktop, title;
        public uint x, y, xSize, ySize, xChars, yChars, fill, flags;
        public ushort show, reservedSize;
        public IntPtr reservedBytes, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long processTime, jobTime;
        public uint flags;
        public UIntPtr minWorkingSet, maxWorkingSet;
        public uint activeProcessLimit;
        public UIntPtr affinity;
        public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits basic;
        public IoCounters io;
        public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Accounting {
        public long userTime, kernelTime, periodUserTime, periodKernelTime;
        public uint pageFaults, totalProcesses, activeProcesses, terminatedProcesses;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", EntryPoint = "QueryInformationJobObject", SetLastError = true)]
    static extern bool QueryProcessIds(IntPtr job, int kind, IntPtr info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string cwd,
        ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    // Win32/CRT 参数转义，保留空串、引号和结尾反斜杠。 / Preserve empty args, quotes and trailing backslashes.
    static string Quote(string value) {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value) {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); }
            else { result.Append('\\', slashes); result.Append(character); }
            slashes = 0;
        }
        result.Append('\\', slashes * 2);
        return result.Append('"').ToString();
    }

    static uint Active(IntPtr job) {
        Accounting info;
        if (!QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return info.activeProcesses;
    }

    // 仅查询本 job 的 PID/名称，失败仍照常关闭所有权，不扫描或终结外部进程。 / Describe only this job's members; cleanup never targets outside processes.
    static string DescribeRemaining(IntPtr job) {
        int size = 8 + 4096 * IntPtr.Size;
        IntPtr memory = Marshal.AllocHGlobal(size);
        try {
            if (!QueryProcessIds(job, 3, memory, (uint)size, IntPtr.Zero)) return "details unavailable";
            int count = Math.Min(16, Math.Max(0, Marshal.ReadInt32(memory, 4)));
            var result = new StringBuilder();
            for (int index = 0; index < count; index++) {
                int pid = checked((int)Marshal.ReadIntPtr(memory, 8 + index * IntPtr.Size).ToInt64());
                string name;
                try { using (var member = System.Diagnostics.Process.GetProcessById(pid)) name = member.ProcessName; }
                catch (ArgumentException) { name = "exited"; }
                catch (Win32Exception) { name = "unavailable"; }
                if (index != 0) result.Append(", ");
                result.Append(pid).Append(':').Append(name);
            }
            return result.ToString();
        } finally { Marshal.FreeHGlobal(memory); }
    }

    public static int Run(string executable, string[] arguments, string cwd) {
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        ProcessInfo process = new ProcessInfo();
        bool assigned = false;
        try {
            var limits = new ExtendedLimits();
            limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            int size = Marshal.SizeOf(typeof(ExtendedLimits));
            IntPtr memory = Marshal.AllocHGlobal(size);
            try {
                Marshal.StructureToPtr(limits, memory, false);
                if (!SetInformationJobObject(job, 9, memory, (uint)size))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
            } finally { Marshal.FreeHGlobal(memory); }
            var command = new StringBuilder(Quote(executable));
            foreach (string argument in arguments ?? new string[0]) command.Append(' ').Append(Quote(argument));
            var startup = new StartupInfo();
            startup.cb = (uint)Marshal.SizeOf(typeof(StartupInfo));
            startup.flags = 0x100; // STARTF_USESTDHANDLES
            startup.input = GetStdHandle(-10); startup.output = GetStdHandle(-11); startup.error = GetStdHandle(-12);
            // 先挂入 job 再运行；隐藏窗口，子进程无法在准入前逃出。 / Assign before resume, with no visible window.
            if (!CreateProcessW(null, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, cwd, ref startup, out process))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if (!AssignProcessToJobObject(job, process.process)) throw new Win32Exception(Marshal.GetLastWin32Error());
            assigned = true;
            if (ResumeThread(process.thread) == uint.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (WaitForSingleObject(process.process, uint.MaxValue) != 0) throw new Win32Exception(Marshal.GetLastWin32Error());
            uint exitCode;
            if (!GetExitCodeProcess(process.process, out exitCode)) throw new Win32Exception(Marshal.GetLastWin32Error());
            // 正常退出也不遗留后台服务。 / A successful command must not leave background descendants.
            for (int attempt = 0; attempt < 50 && Active(job) != 0; attempt++) Thread.Sleep(10);
            uint remaining = Active(job);
            if (remaining != 0) {
                Console.Error.WriteLine("[test-step] reclaiming " + remaining + " process(es) left by the command: " + DescribeRemaining(job));
                if (exitCode == 0) exitCode = 125;
            }
            return unchecked((int)exitCode);
        } finally {
            if (!assigned && process.process != IntPtr.Zero) TerminateProcess(process.process, 125);
            CloseHandle(job);
            if (process.thread != IntPtr.Zero) CloseHandle(process.thread);
            if (process.process != IntPtr.Zero) CloseHandle(process.process);
        }
    }
}
'@
try {
    exit [TiangZTestStepJob]::Run($Executable, $stepArguments, $WorkingDirectory)
} catch {
    [Console]::Error.WriteLine('[test-step] Windows job failed: ' + $_.Exception.Message)
    exit 125
}
