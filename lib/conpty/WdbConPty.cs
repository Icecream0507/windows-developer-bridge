// WdbConPty.cs - ConPTY host helper for Windows Developer Bridge.
//
// Compiled on first use by lib/pty.mjs with the in-box .NET Framework 4 compiler:
//   csc.exe /nologo /optimize+ /target:exe /platform:anycpu WdbConPty.cs
// The source is intentionally restricted to C# 5 syntax.
//
// Usage: wdb-conpty.exe <cols> <rows> <base64-utf8-command-line>
//
// Protocol
//   stdout : raw bytes produced by the pseudo console (VT/UTF-8).
//   stderr : one JSON object per line:
//              {"event":"started","pid":N}
//              {"event":"resized","cols":C,"rows":R,"ok":true}
//              {"event":"resized","cols":C,"rows":R,"ok":false,"error":"..."}
//              {"event":"exit","code":N}
//              {"event":"warning","message":"..."}
//              {"event":"error","message":"..."}       (fatal; helper exits 1)
//   stdin  : ASCII control lines terminated by \n:
//              w <base64>       write decoded bytes to the terminal input
//              r <cols> <rows>  resize the pseudo console
//              k                terminate the whole process tree (job object)
//            EOF terminates the process tree and exits.
//
// The child runs inside a Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, so the
// entire tree dies whenever this helper dies for any reason.
using System;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace WindowsDeveloperBridge
{
    internal static class WdbConPty
    {
        const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        const uint CREATE_SUSPENDED = 0x00000004;
        const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        const int STARTF_USESTDHANDLES = 0x00000100;
        const uint INFINITE = 0xFFFFFFFF;
        const int JobObjectExtendedLimitInformation = 9;
        const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        static readonly IntPtr PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = new IntPtr(0x00020016);

        [StructLayout(LayoutKind.Sequential)]
        struct COORD
        {
            public short X;
            public short Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct STARTUPINFO
        {
            public int cb;
            public IntPtr lpReserved;
            public IntPtr lpDesktop;
            public IntPtr lpTitle;
            public int dwX;
            public int dwY;
            public int dwXSize;
            public int dwYSize;
            public int dwXCountChars;
            public int dwYCountChars;
            public int dwFillAttribute;
            public int dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct STARTUPINFOEX
        {
            public STARTUPINFO StartupInfo;
            public IntPtr lpAttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public int dwProcessId;
            public int dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_BASIC_LIMIT_INFORMATION
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
        struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        delegate bool ConsoleCtrlDelegate(uint ctrlType);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern int CreatePseudoConsole(COORD size, IntPtr hInput, IntPtr hOutput, uint dwFlags, out IntPtr phPC);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern int ResizePseudoConsole(IntPtr hPC, COORD size);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern void ClosePseudoConsole(IntPtr hPC);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe, IntPtr lpPipeAttributes, int nSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool ReadFile(IntPtr hFile, byte[] lpBuffer, int nNumberOfBytesToRead, out int lpNumberOfBytesRead, IntPtr lpOverlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool WriteFile(IntPtr hFile, byte[] lpBuffer, int nNumberOfBytesToWrite, out int lpNumberOfBytesWritten, IntPtr lpOverlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CloseHandle(IntPtr hObject);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr attribute, IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CreateProcessW")]
        static extern bool CreateProcess(string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFOEX lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint ResumeThread(IntPtr hThread);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CreateJobObjectW")]
        static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetInformationJobObject(IntPtr hJob, int jobObjectInfoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpJobObjectInfo, int cbJobObjectInfoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "GetModuleHandleW")]
        static extern IntPtr GetModuleHandle(string lpModuleName);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true)]
        static extern IntPtr GetProcAddress(IntPtr hModule, string procName);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetConsoleCtrlHandler(ConsoleCtrlDelegate handlerRoutine, bool add);

        [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "SetConsoleCtrlHandler")]
        static extern bool SetConsoleCtrlIgnore(IntPtr handlerRoutine, bool add);

        static readonly object EventLock = new object();
        static readonly object PtyLock = new object();
        static readonly ManualResetEvent ExitPathDone = new ManualResetEvent(false);
        static Stream errStream;
        static Stream outStream;
        static IntPtr hPC = IntPtr.Zero;
        static bool ptyClosed;
        static IntPtr hJob = IntPtr.Zero;
        static IntPtr hProcess = IntPtr.Zero;
        static IntPtr inputWrite = IntPtr.Zero;
        static IntPtr outputRead = IntPtr.Zero;
        static volatile bool killRequested;
        static int lastOutputTick;
        static Thread outputThread;
        static ConsoleCtrlDelegate ctrlHandler;

        static int Main(string[] args)
        {
            try { errStream = Console.OpenStandardError(); } catch (Exception) { errStream = Stream.Null; }
            try { outStream = Console.OpenStandardOutput(); } catch (Exception) { outStream = Stream.Null; }
            try
            {
                return Run(args);
            }
            catch (Exception ex)
            {
                Fatal("Unexpected helper failure: " + ex.GetType().Name + ": " + ex.Message);
                return 1;
            }
        }

        static int Run(string[] args)
        {
            if (args.Length != 3)
            {
                Fatal("usage: wdb-conpty.exe <cols> <rows> <base64-utf8-command-line>");
                return 1;
            }
            short cols;
            short rows;
            if (!ParseSize(args[0], out cols) || !ParseSize(args[1], out rows))
            {
                Fatal("cols and rows must be integers between 1 and 32767");
                return 1;
            }
            string commandLine;
            try
            {
                commandLine = Encoding.UTF8.GetString(Convert.FromBase64String(args[2]));
            }
            catch (FormatException)
            {
                Fatal("command line argument is not valid base64");
                return 1;
            }
            if (commandLine.Length == 0)
            {
                Fatal("command line is empty");
                return 1;
            }

            IntPtr kernel32 = GetModuleHandle("kernel32.dll");
            if (kernel32 == IntPtr.Zero || GetProcAddress(kernel32, "CreatePseudoConsole") == IntPtr.Zero)
            {
                Fatal("ConPTY (CreatePseudoConsole) is not available on this system; Windows 10 version 1809 (build 17763) or later is required");
                return 1;
            }

            // The "ignore CTRL+C" attribute is inherited by child processes. The host may have
            // been started in a new process group (which implicitly ignores CTRL+C), so restore
            // normal processing for the child, while this helper itself ignores CTRL+C/BREAK
            // arriving on its own (host) console.
            ctrlHandler = new ConsoleCtrlDelegate(OnConsoleCtrl);
            try { SetConsoleCtrlIgnore(IntPtr.Zero, false); } catch (Exception) { }
            try { SetConsoleCtrlHandler(ctrlHandler, true); } catch (Exception) { }

            IntPtr inputRead;
            IntPtr outputWrite;
            if (!CreatePipe(out inputRead, out inputWrite, IntPtr.Zero, 0))
            {
                Fatal("CreatePipe (input) failed: " + Win32Message(Marshal.GetLastWin32Error()));
                return 1;
            }
            if (!CreatePipe(out outputRead, out outputWrite, IntPtr.Zero, 0))
            {
                Fatal("CreatePipe (output) failed: " + Win32Message(Marshal.GetLastWin32Error()));
                return 1;
            }

            COORD size = new COORD();
            size.X = cols;
            size.Y = rows;
            int hr;
            try
            {
                hr = CreatePseudoConsole(size, inputRead, outputWrite, 0, out hPC);
            }
            catch (EntryPointNotFoundException)
            {
                Fatal("ConPTY (CreatePseudoConsole) is not available on this system; Windows 10 version 1809 (build 17763) or later is required");
                return 1;
            }
            if (hr != 0)
            {
                Fatal("CreatePseudoConsole failed: HRESULT 0x" + hr.ToString("X8", CultureInfo.InvariantCulture));
                return 1;
            }

            hJob = CreateJobObject(IntPtr.Zero, null);
            if (hJob == IntPtr.Zero)
            {
                Fatal("CreateJobObject failed: " + Win32Message(Marshal.GetLastWin32Error()));
                return 1;
            }
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, ref limits, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
            {
                Fatal("SetInformationJobObject failed: " + Win32Message(Marshal.GetLastWin32Error()));
                return 1;
            }

            IntPtr attrSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attrSize);
            if (attrSize == IntPtr.Zero)
            {
                Fatal("InitializeProcThreadAttributeList (size query) failed: " + Win32Message(Marshal.GetLastWin32Error()));
                return 1;
            }
            IntPtr attrList = Marshal.AllocHGlobal(attrSize);
            if (!InitializeProcThreadAttributeList(attrList, 1, 0, ref attrSize))
            {
                Fatal("InitializeProcThreadAttributeList failed: " + Win32Message(Marshal.GetLastWin32Error()));
                return 1;
            }
            if (!UpdateProcThreadAttribute(attrList, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hPC, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
            {
                Fatal("UpdateProcThreadAttribute(PSEUDOCONSOLE) failed: " + Win32Message(Marshal.GetLastWin32Error()));
                return 1;
            }

            STARTUPINFOEX si = new STARTUPINFOEX();
            si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            // Do not let the child pick up this helper's redirected standard handles; with
            // null handles it attaches its standard streams to the pseudo console instead.
            si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            si.StartupInfo.hStdInput = IntPtr.Zero;
            si.StartupInfo.hStdOutput = IntPtr.Zero;
            si.StartupInfo.hStdError = IntPtr.Zero;
            si.lpAttributeList = attrList;

            PROCESS_INFORMATION pi;
            StringBuilder cmd = new StringBuilder(commandLine, commandLine.Length + 1);
            uint flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT;
            if (!CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero, null, ref si, out pi))
            {
                int err = Marshal.GetLastWin32Error();
                Fatal("CreateProcess failed for command line [" + commandLine + "]: " + Win32Message(err));
                return 1;
            }
            hProcess = pi.hProcess;
            if (!AssignProcessToJobObject(hJob, pi.hProcess))
            {
                Emit("{\"event\":\"warning\",\"message\":" + Json("AssignProcessToJobObject failed; descendants may outlive the session: " + Win32Message(Marshal.GetLastWin32Error())) + "}");
            }
            if (ResumeThread(pi.hThread) == 0xFFFFFFFF)
            {
                int err = Marshal.GetLastWin32Error();
                TerminateProcess(pi.hProcess, 1);
                Fatal("ResumeThread failed: " + Win32Message(err));
                return 1;
            }
            CloseHandle(pi.hThread);
            DeleteProcThreadAttributeList(attrList);
            Marshal.FreeHGlobal(attrList);

            // The pseudo console owns its duplicates of these pipe ends now.
            CloseHandle(inputRead);
            CloseHandle(outputWrite);

            Thread.VolatileWrite(ref lastOutputTick, Environment.TickCount);
            Emit("{\"event\":\"started\",\"pid\":" + pi.dwProcessId.ToString(CultureInfo.InvariantCulture) + "}");

            outputThread = new Thread(PumpOutput);
            outputThread.IsBackground = true;
            outputThread.Name = "conpty-output";
            outputThread.Start();

            Thread exitThread = new Thread(WatchExit);
            exitThread.IsBackground = true;
            exitThread.Name = "conpty-exit";
            exitThread.Start();

            ReadControl();

            // stdin closed: the host is gone or wants the session torn down.
            Kill();
            ExitPathDone.WaitOne(15000);
            try { outStream.Flush(); } catch (Exception) { }
            Environment.Exit(0);
            return 0;
        }

        static bool OnConsoleCtrl(uint ctrlType)
        {
            // CTRL_C_EVENT = 0, CTRL_BREAK_EVENT = 1: ignore on the helper's own console.
            return ctrlType == 0 || ctrlType == 1;
        }

        static bool ParseSize(string text, out short value)
        {
            int parsed;
            value = 0;
            if (!int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed)) return false;
            if (parsed < 1 || parsed > 32767) return false;
            value = (short)parsed;
            return true;
        }

        static void ReadControl()
        {
            Stream input;
            try { input = Console.OpenStandardInput(); }
            catch (Exception) { return; }
            StreamReader reader = new StreamReader(input, Encoding.ASCII, false, 65536);
            while (true)
            {
                string line;
                try { line = reader.ReadLine(); }
                catch (Exception) { return; }
                if (line == null) return;
                line = line.Trim();
                if (line.Length == 0) continue;
                char op = line[0];
                try
                {
                    if (op == 'w')
                    {
                        string payload = line.Length > 1 ? line.Substring(1).Trim() : "";
                        byte[] data = Convert.FromBase64String(payload);
                        if (data.Length > 0) WriteInput(data);
                    }
                    else if (op == 'r')
                    {
                        Resize(line);
                    }
                    else if (op == 'k')
                    {
                        Kill();
                    }
                    else
                    {
                        Emit("{\"event\":\"warning\",\"message\":" + Json("unknown control command: " + op) + "}");
                    }
                }
                catch (Exception ex)
                {
                    Emit("{\"event\":\"warning\",\"message\":" + Json("control command '" + op + "' failed: " + ex.Message) + "}");
                }
            }
        }

        static void WriteInput(byte[] data)
        {
            int offset = 0;
            while (offset < data.Length)
            {
                byte[] chunk = data;
                if (offset > 0)
                {
                    chunk = new byte[data.Length - offset];
                    Buffer.BlockCopy(data, offset, chunk, 0, chunk.Length);
                }
                int written;
                if (!WriteFile(inputWrite, chunk, chunk.Length, out written, IntPtr.Zero))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                if (written <= 0) throw new IOException("terminal input pipe accepted no data");
                offset += written;
            }
        }

        static void Resize(string line)
        {
            string[] parts = line.Split(new char[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
            short cols = 0;
            short rows = 0;
            if (parts.Length != 3 || !ParseSize(parts[1], out cols) || !ParseSize(parts[2], out rows))
            {
                Emit("{\"event\":\"resized\",\"cols\":" + cols.ToString(CultureInfo.InvariantCulture) + ",\"rows\":" + rows.ToString(CultureInfo.InvariantCulture) + ",\"ok\":false,\"error\":" + Json("invalid resize command") + "}");
                return;
            }
            string error = null;
            lock (PtyLock)
            {
                if (ptyClosed)
                {
                    error = "pseudo console is closed";
                }
                else
                {
                    COORD size = new COORD();
                    size.X = cols;
                    size.Y = rows;
                    int hr = ResizePseudoConsole(hPC, size);
                    if (hr != 0) error = "ResizePseudoConsole failed: HRESULT 0x" + hr.ToString("X8", CultureInfo.InvariantCulture);
                }
            }
            string head = "{\"event\":\"resized\",\"cols\":" + cols.ToString(CultureInfo.InvariantCulture) + ",\"rows\":" + rows.ToString(CultureInfo.InvariantCulture);
            if (error == null) Emit(head + ",\"ok\":true}");
            else Emit(head + ",\"ok\":false,\"error\":" + Json(error) + "}");
        }

        static void Kill()
        {
            killRequested = true;
            bool done = false;
            if (hJob != IntPtr.Zero) done = TerminateJobObject(hJob, 1);
            if (!done && hProcess != IntPtr.Zero) TerminateProcess(hProcess, 1);
        }

        static void PumpOutput()
        {
            byte[] buffer = new byte[65536];
            while (true)
            {
                int read;
                if (!ReadFile(outputRead, buffer, buffer.Length, out read, IntPtr.Zero)) break;
                if (read <= 0) continue;
                Thread.VolatileWrite(ref lastOutputTick, Environment.TickCount);
                try
                {
                    outStream.Write(buffer, 0, read);
                    outStream.Flush();
                }
                catch (Exception)
                {
                    // Host is gone; keep draining so the pseudo console never blocks.
                }
            }
        }

        static void WatchExit()
        {
            WaitForSingleObject(hProcess, INFINITE);
            uint code;
            if (!GetExitCodeProcess(hProcess, out code)) code = 1;
            Emit("{\"event\":\"exit\",\"code\":" + code.ToString(CultureInfo.InvariantCulture) + "}");

            // Give the pseudo console renderer a moment to paint the final frame before closing.
            if (!killRequested)
            {
                int begin = Environment.TickCount;
                while (true)
                {
                    int now = Environment.TickCount;
                    int elapsed = unchecked(now - begin);
                    int quiet = unchecked(now - Thread.VolatileRead(ref lastOutputTick));
                    if (elapsed >= 1500) break;
                    if (elapsed >= 100 && quiet >= 150) break;
                    Thread.Sleep(25);
                }
            }

            // ClosePseudoConsole may block until output is drained on some builds, so run it on
            // another thread while the output pump keeps draining to EOF.
            Thread closer = new Thread(ClosePty);
            closer.IsBackground = true;
            closer.Name = "conpty-close";
            closer.Start();
            if (outputThread != null) outputThread.Join(10000);
            try { outStream.Flush(); } catch (Exception) { }
            ExitPathDone.Set();
            Environment.Exit(0);
        }

        static void ClosePty()
        {
            IntPtr handle;
            lock (PtyLock)
            {
                if (ptyClosed) return;
                ptyClosed = true;
                handle = hPC;
            }
            try { ClosePseudoConsole(handle); } catch (Exception) { }
        }

        static void Fatal(string message)
        {
            Emit("{\"event\":\"error\",\"message\":" + Json(message) + "}");
            try
            {
                if (hJob != IntPtr.Zero) TerminateJobObject(hJob, 1);
            }
            catch (Exception) { }
        }

        static string Win32Message(int code)
        {
            string text;
            try { text = new Win32Exception(code).Message; }
            catch (Exception) { text = "unknown error"; }
            return "error " + code.ToString(CultureInfo.InvariantCulture) + ": " + text;
        }

        static void Emit(string json)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(json + "\n");
            lock (EventLock)
            {
                try
                {
                    errStream.Write(bytes, 0, bytes.Length);
                    errStream.Flush();
                }
                catch (Exception) { }
            }
        }

        static string Json(string value)
        {
            if (value == null) return "null";
            StringBuilder sb = new StringBuilder(value.Length + 16);
            sb.Append('"');
            for (int i = 0; i < value.Length; i++)
            {
                char c = value[i];
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    default:
                        if (c < 0x20 || c == (char)0x2028 || c == (char)0x2029 || char.IsSurrogate(c))
                        {
                            if (char.IsHighSurrogate(c) && i + 1 < value.Length && char.IsLowSurrogate(value[i + 1]))
                            {
                                sb.Append(c);
                                sb.Append(value[i + 1]);
                                i++;
                            }
                            else
                            {
                                sb.Append("\\u");
                                sb.Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                            }
                        }
                        else
                        {
                            sb.Append(c);
                        }
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }
    }
}
