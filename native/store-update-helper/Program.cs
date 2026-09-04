using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Windows.ApplicationModel;
using Windows.Services.Store;

namespace TWOverlay.StoreUpdateHelper;

/// <summary>
/// Electron은 Windows.Services.Store WinRT API를 직접 노출하지 않으므로 Store 패키지 안에서
/// 실행되는 작은 네이티브 도우미가 확인·다운로드·설치를 담당한다. 표준 출력은 한 줄당 하나의
/// JSON 이벤트로 제한해 Electron 메인 프로세스가 진행 상태를 안전하게 전달받을 수 있게 한다.
/// </summary>
internal static class Program
{
    private const int ProtocolVersion = 1;

    [STAThread]
    private static async Task<int> Main(string[] args)
    {
        if (args.Length == 0)
        {
            WriteError("invalid-arguments", "Expected one of: self-test, check, install");
            return 2;
        }

        try
        {
            return args[0].ToLowerInvariant() switch
            {
                "self-test" => RunSelfTest(),
                "check" => await CheckForUpdatesAsync(),
                "install" => await InstallUpdatesAsync(ParseInstallOptions(args.Skip(1).ToArray())),
                _ => InvalidCommand(args[0]),
            };
        }
        catch (Exception error)
        {
            WriteError($"0x{error.HResult:X8}", error.Message);
            return 1;
        }
    }

    private static int RunSelfTest()
    {
        WriteEvent("self-test", writer =>
        {
            writer.WriteNumber("protocolVersion", ProtocolVersion);
            writer.WriteString("runtime", Environment.Version.ToString());
        });
        return 0;
    }

    private static int InvalidCommand(string command)
    {
        WriteError("invalid-command", $"Unsupported command: {command}");
        return 2;
    }

    private static async Task<int> CheckForUpdatesAsync()
    {
        StoreContext context = StoreContext.GetDefault();
        IReadOnlyList<StorePackageUpdate> updates = await context.GetAppAndOptionalStorePackageUpdatesAsync();

        WriteEvent("check-result", writer =>
        {
            writer.WriteBoolean("updateAvailable", updates.Count > 0);
            writer.WriteBoolean("mandatory", updates.Any(update => update.Mandatory));
            writer.WriteBoolean("canSilentlyInstall", context.CanSilentlyDownloadStorePackageUpdates);
        });
        return 0;
    }

    private static async Task<int> InstallUpdatesAsync(InstallOptions options)
    {
        StoreContext context = StoreContext.GetDefault();
        IReadOnlyList<StorePackageUpdate> updates = await context.GetAppAndOptionalStorePackageUpdatesAsync();
        bool mandatory = updates.Any(update => update.Mandatory);
        if (updates.Count == 0)
        {
            WriteInstallResult(StorePackageUpdateState.Completed, mandatory, noUpdate: true);
            return 0;
        }

        StorePackageUpdateResult result;
        if (context.CanSilentlyDownloadStorePackageUpdates)
        {
            // 무음 API는 세부 진행률을 제공하지 않으므로 다운로드와 설치 단계를 분리해
            // 스플래시에 최소한의 단계 진행 상태(5% → 80% → 90%)를 전달한다.
            WriteProgress("downloading", 5);
            StorePackageUpdateResult downloadResult =
                await context.TrySilentDownloadStorePackageUpdatesAsync(updates);
            if (downloadResult.OverallState != StorePackageUpdateState.Completed)
            {
                WriteInstallResult(downloadResult.OverallState, mandatory);
                return 1;
            }

            WriteProgress("downloaded", 80);
            WriteProgress("deploying", 90);
            result = await context.TrySilentDownloadAndInstallStorePackageUpdatesAsync(updates);
        }
        else
        {
            if (options.WindowHandle == IntPtr.Zero)
            {
                WriteEvent("permission-required", writer =>
                {
                    writer.WriteBoolean("mandatory", mandatory);
                    writer.WriteString("message", "Microsoft Store user consent is required.");
                });
                return 3;
            }

            // Store 자동 업데이트가 꺼져 있거나 데이터 통신 제한이 있으면 Microsoft가 제공하는
            // 동의 UI를 사용한다. Desktop Bridge 앱은 이 UI의 소유 HWND를 반드시 지정해야 한다.
            WinRT.Interop.InitializeWithWindow.Initialize(context, options.WindowHandle);
            var operation = context.RequestDownloadAndInstallStorePackageUpdatesAsync(updates);
            operation.Progress = (_, progress) =>
            {
                string phase = progress.PackageUpdateState == StorePackageUpdateState.Deploying
                    ? "deploying"
                    : "downloading";
                WriteProgress(phase, (int)Math.Round(progress.PackageDownloadProgress * 100));
            };
            result = await operation;
        }

        WriteInstallResult(result.OverallState, mandatory);
        if (result.OverallState != StorePackageUpdateState.Completed)
        {
            return 1;
        }

        // 정상적인 Store 배포에서는 패키지 프로세스가 Windows에 의해 종료될 수 있다. 종료되지
        // 않고 결과가 반환된 경우에는 Electron이 안전 종료한 뒤 이 도우미가 새 패키지를 활성화한다.
        // 두 경로 모두를 지원해 Store/Windows 버전에 따른 재시작 동작 차이를 흡수한다.
        await RestartAfterParentExitAsync(options);
        return 0;
    }

    private static InstallOptions ParseInstallOptions(string[] args)
    {
        long windowHandle = 0;
        int parentProcessId = 0;
        string applicationId = "twOverlay";

        for (int index = 0; index < args.Length; index++)
        {
            string value = index + 1 < args.Length ? args[index + 1] : string.Empty;
            switch (args[index])
            {
                case "--window-handle" when long.TryParse(value, out long parsedHandle):
                    windowHandle = parsedHandle;
                    index++;
                    break;
                case "--parent-pid" when int.TryParse(value, out int parsedPid):
                    parentProcessId = parsedPid;
                    index++;
                    break;
                case "--application-id" when !string.IsNullOrWhiteSpace(value):
                    applicationId = value;
                    index++;
                    break;
                default:
                    throw new ArgumentException($"Invalid install argument: {args[index]}");
            }
        }

        return new InstallOptions(new IntPtr(windowHandle), parentProcessId, applicationId);
    }

    private static async Task RestartAfterParentExitAsync(InstallOptions options)
    {
        if (options.ParentProcessId <= 0)
        {
            return;
        }

        try
        {
            using Process parent = Process.GetProcessById(options.ParentProcessId);
            using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(30));
            await parent.WaitForExitAsync(timeout.Token);
        }
        catch (ArgumentException)
        {
            // Electron이 이미 종료된 경우 바로 새 패키지를 활성화한다.
        }
        catch (OperationCanceledException)
        {
            WriteError("restart-timeout", "The parent app did not exit within 30 seconds.");
            return;
        }

        await Task.Delay(500);
        string appUserModelId = $"{Package.Current.Id.FamilyName}!{options.ApplicationId}";
        Process.Start(new ProcessStartInfo
        {
            FileName = "explorer.exe",
            Arguments = $"shell:AppsFolder\\{appUserModelId}",
            UseShellExecute = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        });
    }

    private static void WriteProgress(string phase, int percent)
    {
        WriteEvent("progress", writer =>
        {
            writer.WriteString("phase", phase);
            writer.WriteNumber("percent", Math.Clamp(percent, 0, 100));
        });
    }

    private static void WriteInstallResult(StorePackageUpdateState state, bool mandatory, bool noUpdate = false)
    {
        WriteEvent("install-result", writer =>
        {
            writer.WriteString("state", state.ToString().ToLowerInvariant());
            writer.WriteBoolean("completed", state == StorePackageUpdateState.Completed);
            writer.WriteBoolean("mandatory", mandatory);
            writer.WriteBoolean("noUpdate", noUpdate);
        });
    }

    private static void WriteError(string code, string message)
    {
        WriteEvent("error", writer =>
        {
            writer.WriteString("code", code);
            writer.WriteString("message", message);
        });
    }

    private static void WriteEvent(string type, Action<Utf8JsonWriter> writeFields)
    {
        using MemoryStream stream = new();
        using (Utf8JsonWriter writer = new(stream))
        {
            writer.WriteStartObject();
            writer.WriteString("type", type);
            writeFields(writer);
            writer.WriteEndObject();
        }

        Console.WriteLine(Encoding.UTF8.GetString(stream.ToArray()));
        Console.Out.Flush();
    }

    private readonly record struct InstallOptions(
        IntPtr WindowHandle,
        int ParentProcessId,
        string ApplicationId);
}
