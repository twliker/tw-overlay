using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace Twoverlay.FakeTalesWeaver;

internal enum FixtureMode
{
    Windowed,
    Borderless,
}

internal sealed record FixtureOptions(
    FixtureMode Mode,
    int MonitorIndex,
    Rectangle? WindowedBounds,
    bool TopMost,
    bool Activate,
    string Role,
    string? StatusFile,
    string? CommandFile,
    int? LifetimeMs)
{
    public static FixtureOptions Parse(string[] args)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var flags = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < args.Length; index++)
        {
            var arg = args[index];
            if (!arg.StartsWith("--", StringComparison.Ordinal)) continue;
            if (index + 1 < args.Length && !args[index + 1].StartsWith("--", StringComparison.Ordinal))
            {
                values[arg] = args[++index];
            }
            else
            {
                flags.Add(arg);
            }
        }

        var mode = values.GetValueOrDefault("--mode", "windowed").ToLowerInvariant() switch
        {
            "windowed" => FixtureMode.Windowed,
            "borderless" => FixtureMode.Borderless,
            var value => throw new ArgumentException($"Unsupported mode: {value}"),
        };
        var monitorIndex = ParseInt(values.GetValueOrDefault("--monitor"), 0);
        Rectangle? bounds = null;
        if (values.TryGetValue("--bounds", out var boundsText))
        {
            var parts = boundsText.Split(',').Select(value => int.Parse(value.Trim())).ToArray();
            if (parts.Length != 4 || parts[2] < 320 || parts[3] < 240)
            {
                throw new ArgumentException("--bounds must be x,y,width,height with a minimum size of 320x240");
            }
            bounds = new Rectangle(parts[0], parts[1], parts[2], parts[3]);
        }

        int? lifetimeMs = null;
        if (values.TryGetValue("--lifetime-ms", out var lifetimeText))
        {
            lifetimeMs = int.Parse(lifetimeText);
            if (lifetimeMs < 100) throw new ArgumentException("--lifetime-ms must be at least 100");
        }

        return new FixtureOptions(
            mode,
            monitorIndex,
            bounds,
            flags.Contains("--topmost"),
            flags.Contains("--activate"),
            values.GetValueOrDefault("--role", "game"),
            values.GetValueOrDefault("--status-file"),
            values.GetValueOrDefault("--command-file"),
            lifetimeMs);
    }

    private static int ParseInt(string? value, int fallback) => value is null ? fallback : int.Parse(value);
}

internal sealed class FixtureCommand
{
    public long Sequence { get; set; }
    public string? Action { get; set; }
    public string? Mode { get; set; }
    public bool? TopMost { get; set; }
}

internal sealed class FixtureForm : Form
{
    private const int SwRestore = 9;
    private readonly FixtureOptions options;
    private readonly System.Windows.Forms.Timer commandTimer = new() { Interval = 50 };
    private readonly System.Windows.Forms.Timer? lifetimeTimer;
    private readonly Label statusLabel = new();
    private FixtureMode mode;
    private long lastCommandSequence;
    private string lastCommand = "startup";
    private bool lastActivationResult;

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hwnd, int command);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, IntPtr processId);

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint firstThreadId, uint secondThreadId, bool attach);

    [DllImport("user32.dll")]
    private static extern IntPtr SetFocus(IntPtr hwnd);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    public FixtureForm(FixtureOptions options)
    {
        this.options = options;
        mode = options.Mode;
        Text = options.Role.Equals("game", StringComparison.OrdinalIgnoreCase)
            ? "Talesweaver Z-Order Fixture"
            : "Twoverlay External Window Fixture";
        Name = "FakeTalesWeaverFixture";
        StartPosition = FormStartPosition.Manual;
        BackColor = Color.FromArgb(20, 27, 42);
        ForeColor = Color.White;
        KeyPreview = true;
        TopMost = options.TopMost;

        statusLabel.Dock = DockStyle.Fill;
        statusLabel.TextAlign = ContentAlignment.MiddleCenter;
        statusLabel.Font = new Font("Segoe UI", 16, FontStyle.Bold);
        Controls.Add(statusLabel);

        Shown += (_, _) =>
        {
            ApplyMode(mode);
            if (options.Activate) ActivateFixture();
            WriteStatus();
        };
        Move += (_, _) => WriteStatus();
        Resize += (_, _) => WriteStatus();
        FormClosed += (_, _) =>
        {
            commandTimer.Stop();
            lifetimeTimer?.Stop();
            lastCommand = "closed";
            WriteStatus();
        };
        KeyDown += (_, eventArgs) =>
        {
            if (eventArgs.KeyCode == Keys.F11)
            {
                ApplyMode(mode == FixtureMode.Windowed ? FixtureMode.Borderless : FixtureMode.Windowed);
            }
            else if (eventArgs.KeyCode == Keys.F8)
            {
                TopMost = !TopMost;
                lastCommand = "toggle-topmost";
                WriteStatus();
            }
            else if (eventArgs.KeyCode == Keys.F9)
            {
                WindowState = FormWindowState.Minimized;
                lastCommand = "minimize";
                WriteStatus();
            }
            else if (eventArgs.Control && eventArgs.KeyCode == Keys.Q)
            {
                Close();
            }
        };

        if (!string.IsNullOrWhiteSpace(options.CommandFile))
        {
            commandTimer.Tick += (_, _) => ProcessCommandFile();
            commandTimer.Start();
        }
        if (options.LifetimeMs is int lifetimeMs)
        {
            lifetimeTimer = new System.Windows.Forms.Timer { Interval = lifetimeMs };
            lifetimeTimer.Tick += (_, _) => Close();
            lifetimeTimer.Start();
        }
    }

    private Screen ResolveScreen()
    {
        var screens = Screen.AllScreens;
        var index = Math.Clamp(options.MonitorIndex, 0, Math.Max(0, screens.Length - 1));
        return screens[index];
    }

    private void ApplyMode(FixtureMode nextMode)
    {
        mode = nextMode;
        var screen = ResolveScreen();
        if (mode == FixtureMode.Borderless)
        {
            WindowState = FormWindowState.Normal;
            FormBorderStyle = FormBorderStyle.None;
            Bounds = screen.Bounds;
        }
        else
        {
            WindowState = FormWindowState.Normal;
            FormBorderStyle = FormBorderStyle.Sizable;
            if (options.WindowedBounds is Rectangle requested)
            {
                Bounds = requested;
            }
            else
            {
                var area = screen.WorkingArea;
                var width = Math.Min(1280, Math.Max(640, area.Width - 120));
                var height = Math.Min(720, Math.Max(480, area.Height - 120));
                Bounds = new Rectangle(
                    area.Left + (area.Width - width) / 2,
                    area.Top + (area.Height - height) / 2,
                    width,
                    height);
            }
        }
        lastCommand = $"mode-{mode.ToString().ToLowerInvariant()}";
        UpdateLabel();
        WriteStatus();
    }

    private bool ActivateFixture()
    {
        if (WindowState == FormWindowState.Minimized) ShowWindow(Handle, SwRestore);
        Show();
        var foregroundHwnd = GetForegroundWindow();
        var currentThreadId = GetCurrentThreadId();
        var foregroundThreadId = foregroundHwnd == IntPtr.Zero
            ? 0
            : GetWindowThreadProcessId(foregroundHwnd, IntPtr.Zero);
        var attached = foregroundThreadId != 0
            && foregroundThreadId != currentThreadId
            && AttachThreadInput(currentThreadId, foregroundThreadId, true);
        bool requested;
        try
        {
            BringToFront();
            Activate();
            requested = BringWindowToTop(Handle) && SetForegroundWindow(Handle);
            SetFocus(Handle);
        }
        finally
        {
            if (attached) AttachThreadInput(currentThreadId, foregroundThreadId, false);
        }
        lastActivationResult = requested && GetForegroundWindow() == Handle;
        lastCommand = "activate";
        WriteStatus();
        return lastActivationResult;
    }

    private void ProcessCommandFile()
    {
        var commandFile = options.CommandFile;
        if (string.IsNullOrWhiteSpace(commandFile) || !File.Exists(commandFile)) return;
        try
        {
            var command = JsonSerializer.Deserialize<FixtureCommand>(
                File.ReadAllText(commandFile),
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            if (command is null || command.Sequence <= lastCommandSequence) return;
            lastCommandSequence = command.Sequence;
            if (!string.IsNullOrWhiteSpace(command.Mode))
            {
                ApplyMode(command.Mode.Equals("borderless", StringComparison.OrdinalIgnoreCase)
                    ? FixtureMode.Borderless
                    : FixtureMode.Windowed);
            }
            if (command.TopMost is bool topMost) TopMost = topMost;
            switch (command.Action?.ToLowerInvariant())
            {
                case "activate":
                    ActivateFixture();
                    break;
                case "minimize":
                    WindowState = FormWindowState.Minimized;
                    lastCommand = "minimize";
                    break;
                case "restore":
                    ShowWindow(Handle, SwRestore);
                    WindowState = FormWindowState.Normal;
                    lastCommand = "restore";
                    break;
                case "close":
                    Close();
                    return;
                default:
                    lastCommand = command.Action ?? "update";
                    break;
            }
            UpdateLabel();
            WriteStatus();
        }
        catch (IOException)
        {
            // 테스트 프로세스가 원자적 교체 중이면 다음 tick에 다시 읽는다.
        }
        catch (JsonException)
        {
            // 완성되지 않은 명령은 다음 tick에 다시 읽는다.
        }
    }

    private void UpdateLabel()
    {
        statusLabel.Text = $"{Text}\n\nMode: {mode}\nPID: {Environment.ProcessId}\nHWND: 0x{Handle.ToInt64():X}\n\nF11 mode  ·  F8 Topmost  ·  F9 minimize  ·  Ctrl+Q close";
    }

    private void WriteStatus()
    {
        UpdateLabel();
        var statusFile = options.StatusFile;
        if (string.IsNullOrWhiteSpace(statusFile) || !IsHandleCreated) return;
        try
        {
            var screen = ResolveScreen();
            var payload = new
            {
                processId = Environment.ProcessId,
                hwnd = Handle.ToInt64().ToString(),
                title = Text,
                role = options.Role,
                mode = mode.ToString().ToLowerInvariant(),
                topMost = TopMost,
                bounds = new { X = Bounds.X, Y = Bounds.Y, Width = Bounds.Width, Height = Bounds.Height },
                screenBounds = new { X = screen.Bounds.X, Y = screen.Bounds.Y, Width = screen.Bounds.Width, Height = screen.Bounds.Height },
                windowState = WindowState.ToString().ToLowerInvariant(),
                foregroundHwnd = GetForegroundWindow().ToInt64().ToString(),
                commandSequence = lastCommandSequence,
                lastCommand,
                lastActivationResult,
                timestamp = DateTimeOffset.UtcNow,
            };
            var directory = Path.GetDirectoryName(statusFile);
            if (!string.IsNullOrWhiteSpace(directory)) Directory.CreateDirectory(directory);
            var temporaryPath = statusFile + ".tmp";
            File.WriteAllText(temporaryPath, JsonSerializer.Serialize(payload));
            File.Move(temporaryPath, statusFile, true);
        }
        catch (IOException)
        {
            // 관찰자가 읽는 순간과 겹치면 다음 상태 변경에서 다시 저장한다.
        }
    }
}

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        var options = FixtureOptions.Parse(args);
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new FixtureForm(options));
    }
}
