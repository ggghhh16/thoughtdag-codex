using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

// Windows console programs create a visible conhost window when their GUI
// parent has no console. Start Codex inside its own hidden console so every
// console descendant can inherit that same invisible console instead of
// flashing a new PowerShell/cmd/git window on the user's desktop.
internal static class HiddenConsoleLauncher
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NEW_CONSOLE = 0x00000010;
    private const uint STARTF_USESHOWWINDOW = 0x00000001;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const short SW_HIDE = 0;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint INFINITE = 0xFFFFFFFF;
    private static readonly IntPtr InvalidHandle = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFO
    {
        public uint cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    private static string QuoteArgument(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
            return value;

        var result = new StringBuilder();
        result.Append('"');
        var backslashes = 0;
        foreach (var character in value)
        {
            if (character == '\\')
            {
                backslashes += 1;
                continue;
            }
            if (character == '"')
            {
                result.Append('\\', backslashes * 2 + 1);
                result.Append('"');
                backslashes = 0;
                continue;
            }
            if (backslashes > 0)
            {
                result.Append('\\', backslashes);
                backslashes = 0;
            }
            result.Append(character);
        }
        result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static IntPtr InheritableStandardHandle(int kind)
    {
        var handle = GetStdHandle(kind);
        if (handle == IntPtr.Zero || handle == InvalidHandle)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Missing redirected standard handle");
        if (!SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not inherit redirected standard handle");
        return handle;
    }

    private static int Fail(string message)
    {
        Console.Error.WriteLine("ThoughtDAG hidden Codex launcher: " + message);
        return 126;
    }

    public static int Main(string[] args)
    {
        var codexPath = Environment.GetEnvironmentVariable("THOUGHTDAG_CODEX_EXECUTABLE");
        if (String.IsNullOrWhiteSpace(codexPath))
            return Fail("THOUGHTDAG_CODEX_EXECUTABLE is missing.");

        IntPtr job = IntPtr.Zero;
        var process = new PROCESS_INFORMATION();
        try
        {
            var commandLine = new StringBuilder(QuoteArgument(codexPath));
            foreach (var argument in args)
            {
                commandLine.Append(' ');
                commandLine.Append(QuoteArgument(argument));
            }

            var startup = new STARTUPINFO();
            startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES;
            startup.wShowWindow = SW_HIDE;
            startup.hStdInput = InheritableStandardHandle(-10);
            startup.hStdOutput = InheritableStandardHandle(-11);
            startup.hStdError = InheritableStandardHandle(-12);

            if (!CreateProcessW(
                codexPath,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CREATE_SUSPENDED | CREATE_NEW_CONSOLE,
                IntPtr.Zero,
                null,
                ref startup,
                out process))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not start Codex");

            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not create Codex process job");

            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                ref limits,
                (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not configure Codex process job");
            if (!AssignProcessToJobObject(job, process.hProcess))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not contain Codex process tree");
            if (ResumeThread(process.hThread) == UInt32.MaxValue)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not resume Codex");

            CloseHandle(process.hThread);
            process.hThread = IntPtr.Zero;
            WaitForSingleObject(process.hProcess, INFINITE);
            uint exitCode;
            if (!GetExitCodeProcess(process.hProcess, out exitCode))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not read Codex exit code");
            return unchecked((int)exitCode);
        }
        catch (Exception error)
        {
            if (process.hProcess != IntPtr.Zero)
                TerminateProcess(process.hProcess, 126);
            return Fail(error.Message);
        }
        finally
        {
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }
}
