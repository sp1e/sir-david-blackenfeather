using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;
using System.Security.Principal;

namespace SirDavid;

internal static class Program
{
    public const string Name = "Sir David Blackenfeather";
    public static string? StartupReport;
    public static bool BackgroundStart;
    public static readonly string StateDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SirDavidBlackenfeather");
    [STAThread]
    static void Main(string[] args)
    {
        if (args.Length == 2 && (args[0] == "--self-test" || args[0] == "--policy-self-test"))
        {
            SelfTest.Run(args[1], args[0] == "--self-test");
            return;
        }
        ApplicationConfiguration.Initialize();
        BackgroundStart = args.Length == 1 && args[0] == "--background";
        var instanceName = "Local\\SirDavidBlackenfeather-" + (WindowsIdentity.GetCurrent().User?.Value ?? Environment.UserName);
        using var instance = new Mutex(true, instanceName, out var firstInstance);
        using var activate = new EventWaitHandle(false, EventResetMode.AutoReset, instanceName + "-activate");
        if (!firstInstance) { if (!BackgroundStart) activate.Set(); return; }
        if (args.Length == 2 && args[0] == "--startup-report") StartupReport = Path.GetFullPath(args[1]);
        try { Application.Run(new CompanionWindow(activate)); }
        catch { MessageBox.Show("Sir David kunde inte starta. Kontrollera installationen och försök igen.", Name, MessageBoxButtons.OK, MessageBoxIcon.Error); }
    }
}

internal record ReminderMessage(string Type, bool? Notifications = null, string? ClaimId = null);
internal static class ReminderPolicy
{
    public static ReminderMessage? Parse(string source, string currentPage, string json)
    {
        try {
            if (json.Length > 1024 || !NavigationPolicy.ValidStart(currentPage) || source != currentPage) return null;
            var uri = new Uri(currentPage);
            if (uri.AbsolutePath != "/admin/" && uri.AbsolutePath != "/admin" && uri.AbsolutePath != "/admin/index.html") return null;
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String) return null;
            var fields = root.EnumerateObject().Select(p => p.Name).ToArray();
            if (fields.Distinct().Count() != fields.Length) return null;
            switch (type.GetString()) {
                case "sir-david-ready" when fields.Length == 1: return new("ready");
                case "sir-david-preferences" when fields.Length == 2 && root.TryGetProperty("notifications", out var enabled) && (enabled.ValueKind == JsonValueKind.True || enabled.ValueKind == JsonValueKind.False): return new("preferences", enabled.GetBoolean());
                case "sir-david-reminder" when fields.Length == 4 && fields.All(p => new[] { "type", "claimId", "title", "body" }.Contains(p)):
                    if (!root.TryGetProperty("claimId", out var claim) || claim.ValueKind != JsonValueKind.String || !Guid.TryParseExact(claim.GetString(), "D", out _)) return null;
                    if (root.GetProperty("title").ValueKind != JsonValueKind.String || root.GetProperty("body").ValueKind != JsonValueKind.String || root.GetProperty("title").GetString()!.Length > 80 || root.GetProperty("body").GetString()!.Length > 240) return null;
                    return new("reminder", ClaimId: claim.GetString());
            }
        } catch { }
        return null;
    }
}

internal record ReminderPreferences(bool Notifications = false)
{
    public static readonly string PathName = Path.Combine(Program.StateDirectory, "reminders.json");
    public static ReminderPreferences Load() { try { return JsonSerializer.Deserialize<ReminderPreferences>(File.ReadAllText(PathName)) ?? new(); } catch { return new(); } }
    public void Save()
    {
        Directory.CreateDirectory(Program.StateDirectory);
        File.WriteAllText(PathName + ".tmp", JsonSerializer.Serialize(this)); File.Move(PathName + ".tmp", PathName, true);
        // Only this program's own per-user startup entry is changed.
        using var run = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run");
        if (Notifications) run.SetValue("SirDavidBlackenfeather", "\"" + Environment.ProcessPath + "\" --background");
        else run.DeleteValue("SirDavidBlackenfeather", false);
    }
}

internal static class NavigationPolicy
{
    public static bool SameOrigin(string candidate) =>
        Uri.TryCreate(candidate, UriKind.Absolute, out var uri) &&
        uri.Scheme == Uri.UriSchemeHttps && (uri.IdnHost == "sp1e.se" || uri.IdnHost == "www.sp1e.se") && uri.Port == 443 && string.IsNullOrEmpty(uri.UserInfo);
    public static bool ValidStart(string candidate) =>
        SameOrigin(candidate) && Uri.TryCreate(candidate, UriKind.Absolute, out var uri) &&
        (uri.AbsolutePath == "/admin" || uri.AbsolutePath.StartsWith("/admin/", StringComparison.Ordinal));

    public static bool ValidPairing(string candidate, string source)
    {
        if (!ValidStart(source) || !Uri.TryCreate(source, UriKind.Absolute, out var origin)
            || !Uri.TryCreate(candidate, UriKind.Absolute, out var uri)) return false;
        var expected = "http://127.0.0.1:4318/__connect/?origin=" + Uri.EscapeDataString(origin.GetLeftPart(UriPartial.Authority));
        return candidate == expected && string.IsNullOrEmpty(uri.UserInfo) && string.IsNullOrEmpty(uri.Fragment);
    }
}

internal record AppConfig(string StartUrl)
{
    public static AppConfig Load(string path)
    {
        var json = JsonDocument.Parse(File.ReadAllText(path));
        var url = json.RootElement.GetProperty("startUrl").GetString() ?? "";
        if (!NavigationPolicy.ValidStart(url)) throw new InvalidDataException("Appen behöver en skyddad Admin-adress på sp1e.se.");
        return new(url);
    }
}

internal static class PermissionPolicy
{
    public static CoreWebView2PermissionState State(CoreWebView2PermissionKind kind, string requester, string currentPage)
    {
        // Audio still follows the shared sound preference in the Admin client.
        // The embedded client permits autoplay only within that private view.
        return kind == CoreWebView2PermissionKind.Autoplay && NavigationPolicy.ValidStart(currentPage)
            && NavigationPolicy.SameOrigin(requester)
            && new Uri(requester).GetLeftPart(UriPartial.Authority) == new Uri(currentPage).GetLeftPart(UriPartial.Authority)
            ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny;
    }
}

internal record WindowPreferences(int Width = 760, int Height = 860, bool AlwaysOnTop = false)
{
    public static WindowPreferences Load(string path)
    {
        try { return JsonSerializer.Deserialize<WindowPreferences>(File.ReadAllText(path)) ?? new(); }
        catch { return new(); }
    }
    public void Save(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path + ".tmp", JsonSerializer.Serialize(this));
        File.Move(path + ".tmp", path, true);
    }
}

internal sealed class CompanionWindow : Form
{
    private readonly WebView2 browser = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(13, 22, 18) };
    private readonly ToolStrip toolbar = new() { GripStyle = ToolStripGripStyle.Hidden, BackColor = Color.FromArgb(27, 42, 33), ForeColor = Color.FromArgb(236, 237, 220), Padding = new Padding(8), RenderMode = ToolStripRenderMode.System };
    private readonly ToolStripButton home = new("Sir David");
    private readonly ToolStripButton reload = new("Ladda om");
    private readonly ToolStripButton pin = new("Överst") { CheckOnClick = true };
    private readonly ToolStripButton openWeb = new("Öppna i webbläsaren");
    private readonly ToolStripLabel status = new("Ansluter till privat Admin…");
    private readonly string preferencesPath = Path.Combine(Program.StateDirectory, "window.json");
    private AppConfig? config;
    private readonly NotifyIcon tray = new() { Text = Program.Name };
    private readonly System.Windows.Forms.Timer reminderTimer = new() { Interval = 60000 };
    private readonly System.Windows.Forms.Timer activationTimer = new() { Interval = 500 };
    private readonly HashSet<string> displayedClaims = new();
    private bool notifications = ReminderPreferences.Load().Notifications, exiting, startupChecked;

    public CompanionWindow(EventWaitHandle activate)
    {
        Text = Program.Name;
        Icon = Icon.ExtractAssociatedIcon(Environment.ProcessPath!);
        tray.Icon = Icon ?? SystemIcons.Information;
        var menu = new ContextMenuStrip();
        menu.Items.Add("Öppna Sir David", null, (_, _) => OpenMain());
        menu.Items.Add("Avsluta Sir David", null, (_, _) => { exiting = true; Close(); });
        tray.ContextMenuStrip = menu; tray.Visible = true;
        tray.DoubleClick += (_, _) => OpenMain(); tray.BalloonTipClicked += (_, _) => OpenMain();
        activationTimer.Tick += (_, _) => { if (activate.WaitOne(0)) OpenMain(); }; activationTimer.Start();
        reminderTimer.Tick += (_, _) => SendReminderTick(); reminderTimer.Start();
        var preferences = WindowPreferences.Load(preferencesPath);
        var workingArea = Screen.PrimaryScreen!.WorkingArea;
        Size = new Size(Math.Clamp(preferences.Width, 480, Math.Max(480, workingArea.Width)), Math.Clamp(preferences.Height, 540, Math.Max(540, workingArea.Height)));
        MinimumSize = new Size(480, 540);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(13, 22, 18);
        TopMost = pin.Checked = preferences.AlwaysOnTop;
        toolbar.Items.AddRange([home, reload, pin, openWeb, new ToolStripSeparator(), status]);
        Controls.Add(browser);
        Controls.Add(toolbar);
        home.Click += (_, _) => { if (config is not null && browser.CoreWebView2 is not null) browser.CoreWebView2.Navigate(config.StartUrl); };
        reload.Click += (_, _) => browser.CoreWebView2?.Reload();
        pin.CheckedChanged += (_, _) => TopMost = pin.Checked;
        openWeb.Click += (_, _) => {
            try { if (config is not null) System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(config.StartUrl) { UseShellExecute = true }); }
            catch { status.Text = "Kunde inte öppna webbläsaren"; }
        };
        Shown += async (_, _) => { await InitializeBrowser(); if (Program.BackgroundStart && notifications) { Hide(); SendReminderTick(); } };
        Resize += (_, _) => SendReminderTick();
        FormClosing += (_, e) => {
            var size = WindowState == FormWindowState.Normal ? Size : RestoreBounds.Size;
            try { new WindowPreferences(size.Width, size.Height, TopMost).Save(preferencesPath); } catch { }
            if (!exiting && notifications && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); SendReminderTick(); }
        };
        FormClosed += (_, _) => { reminderTimer.Dispose(); activationTimer.Dispose(); tray.Visible = false; tray.Dispose(); };
    }

    private void OpenMain() { Show(); WindowState = FormWindowState.Normal; Activate(); SendReminderTick(); }
    private void SendReminderTick()
    {
        if (browser.CoreWebView2 is not { } core || !NavigationPolicy.ValidStart(core.Source)) return;
        core.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "sir-david-native-tick", visible = Visible && WindowState != FormWindowState.Minimized }));
    }
    private void ReceiveReminder(CoreWebView2WebMessageReceivedEventArgs e)
    {
        var message = ReminderPolicy.Parse(e.Source, browser.CoreWebView2.Source, e.WebMessageAsJson);
        if (message is null) return;
        if (message.Type == "ready") { SendReminderTick(); return; }
        if (message.Type == "preferences") {
            var next = message.Notifications == true;
            if (!startupChecked || notifications != next) { try { new ReminderPreferences(next).Save(); notifications = next; startupChecked = true; } catch { status.Text = "Påminnelsernas Windows-start kunde inte sparas"; } }
            return;
        }
        if (message.Type != "reminder") return;
        var accepted = false;
        if (notifications && !displayedClaims.Contains(message.ClaimId!)) {
            try {
                // Do not expose work titles or appointment details on a locked screen.
                tray.ShowBalloonTip(10000, Program.Name, "Din planering behöver uppmärksamhet. Öppna Sir David för nästa steg.", ToolTipIcon.Info);
                if (displayedClaims.Count >= 100) displayedClaims.Clear();
                displayedClaims.Add(message.ClaimId!); accepted = true;
            } catch { }
        } else accepted = notifications && displayedClaims.Contains(message.ClaimId!);
        browser.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "sir-david-reminder-result", claimId = message.ClaimId, accepted }));
    }

    private async Task InitializeBrowser()
    {
        try
        {
            config = AppConfig.Load(Path.Combine(AppContext.BaseDirectory, "appsettings.json"));
            var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Program.StateDirectory, "Browser"));
            await browser.EnsureCoreWebView2Async(environment);
            RecordStartup("browser-initialized", false);
            browser.CoreWebView2.Settings.AreDevToolsEnabled = false;
            browser.CoreWebView2.Settings.AreHostObjectsAllowed = false;
            browser.CoreWebView2.Settings.IsWebMessageEnabled = true;
            browser.CoreWebView2.WebMessageReceived += (_, e) => ReceiveReminder(e);
            browser.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            browser.CoreWebView2.Settings.IsPasswordAutosaveEnabled = false;
            browser.CoreWebView2.Settings.IsGeneralAutofillEnabled = false;
            browser.CoreWebView2.NavigationStarting += (_, e) => {
                if (!NavigationPolicy.SameOrigin(e.Uri)) { e.Cancel = true; status.Text = "Endast sp1e.se öppnas i appen"; }
                else status.Text = "Ansluter…";
            };
            browser.CoreWebView2.NavigationCompleted += (_, e) => {
                status.Text = e.IsSuccess ? "Sir David · privat Admin" : "Ingen anslutning · tryck Ladda om";
                SendReminderTick();
                RecordStartup("navigation-completed", e.IsSuccess);
                Program.StartupReport = null;
            };
            browser.CoreWebView2.NewWindowRequested += async (_, e) => await OpenPairingWindow(e, environment);
            browser.CoreWebView2.DownloadStarting += (_, e) => { e.Cancel = true; status.Text = "Använd webbläsaren för nedladdningar"; };
            browser.CoreWebView2.PermissionRequested += (_, e) =>
            {
                e.SavesInProfile = false;
                e.State = PermissionPolicy.State(e.PermissionKind, e.Uri, browser.CoreWebView2.Source);
            };
            // Earlier clients persisted a blanket deny. Reset audio only so each
            // request reaches the document-scoped policy above, without changing
            // cookies, the shared sound preference or any other permission.
            foreach (var origin in new[] { "https://sp1e.se", "https://www.sp1e.se" })
                await browser.CoreWebView2.Profile.SetPermissionStateAsync(CoreWebView2PermissionKind.Autoplay, origin, CoreWebView2PermissionState.Default);
            browser.CoreWebView2.Navigate(config.StartUrl);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            status.Text = "Microsoft Edge WebView2 behöver installeras";
            MessageBox.Show("Installera Microsoft Edge WebView2 Runtime från Microsoft och starta Sir David igen.", Program.Name);
        }
        catch
        {
            status.Text = "Kunde inte starta · försök igen";
            MessageBox.Show("Kontrollera internetanslutningen och appens Admin-adress. Starta sedan Sir David igen.", Program.Name);
        }
    }

    private async Task OpenPairingWindow(CoreWebView2NewWindowRequestedEventArgs request, CoreWebView2Environment environment)
    {
        request.Handled = true;
        if (!request.IsUserInitiated || !NavigationPolicy.ValidPairing(request.Uri, browser.CoreWebView2.Source))
        {
            status.Text = "Öppna externa länkar i din vanliga webbläsare";
            return;
        }
        using var deferral = request.GetDeferral();
        Form? pairing = null;
        try
        {
            var target = request.Uri;
            var popup = new WebView2 { Dock = DockStyle.Fill };
            pairing = new Form { Text = "Anslut din lokala agent", Size = new Size(520, 640), StartPosition = FormStartPosition.CenterParent };
            pairing.Controls.Add(popup);
            await popup.EnsureCoreWebView2Async(environment);
            popup.CoreWebView2.Settings.AreDevToolsEnabled = false;
            popup.CoreWebView2.Settings.AreHostObjectsAllowed = false;
            popup.CoreWebView2.Settings.IsWebMessageEnabled = false;
            popup.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            popup.CoreWebView2.Settings.IsPasswordAutosaveEnabled = false;
            popup.CoreWebView2.Settings.IsGeneralAutofillEnabled = false;
            popup.CoreWebView2.NavigationStarting += (_, e) => { if (e.Uri != target) e.Cancel = true; };
            popup.CoreWebView2.NewWindowRequested += (_, e) => e.Handled = true;
            popup.CoreWebView2.DownloadStarting += (_, e) => e.Cancel = true;
            popup.CoreWebView2.PermissionRequested += (_, e) => { e.SavesInProfile = false; e.State = CoreWebView2PermissionState.Deny; };
            popup.CoreWebView2.WindowCloseRequested += (_, _) => pairing.Close();
            // Assign before navigation so WebView2 preserves the opener used by postMessage.
            request.NewWindow = popup.CoreWebView2;
            pairing.Show(this);
        }
        catch
        {
            pairing?.Dispose();
            status.Text = "Kunde inte öppna lokal anslutning. Kontrollera att agentbryggan är igång.";
        }
    }

    private void RecordStartup(string stage, bool navigationSucceeded)
    {
        if (Program.StartupReport is not { } path) return;
        try {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, JsonSerializer.Serialize(new {
                application = Program.Name, stage,
                browserInitialized = browser.CoreWebView2 is not null,
                navigationSucceeded,
                configuredStartUrl = config?.StartUrl,
                runtime = browser.CoreWebView2?.Environment.BrowserVersionString,
                modelRequestsByDesktopHost = 0
            }, new JsonSerializerOptions { WriteIndented = true }));
        } catch { }
    }
}

internal static class SelfTest
{
    public static void Run(string reportPath, bool requireRuntime = true)
    {
        var results = new List<object>();
        var failed = 0;
        void Check(string name, bool passed) { results.Add(new { name, passed }); if (!passed) failed++; }
        Check("Admin HTTPS entry accepted", NavigationPolicy.ValidStart("https://sp1e.se/admin/?panel=sir-david"));
        Check("Canonical www Admin entry accepted", NavigationPolicy.ValidStart("https://www.sp1e.se/admin/?panel=sir-david"));
        Check("Public entry rejected", !NavigationPolicy.ValidStart("https://sp1e.se/"));
        foreach (var url in new[] { "http://sp1e.se/admin/", "https://evil.example/admin/", "https://sp1e.se.evil.example/admin/", "https://user:password@sp1e.se/admin/", "file:///C:/admin/", "javascript:alert(1)", "https://sp1e.se:8443/admin/", "https://sp1e.se/admin-elsewhere" })
            Check("Reject " + url, !NavigationPolicy.ValidStart(url));
        Check("Same-origin login redirect accepted", NavigationPolicy.SameOrigin("https://sp1e.se/portal/"));
        Check("Current configuration accepted", NavigationPolicy.ValidStart(AppConfig.Load(Path.Combine(AppContext.BaseDirectory, "appsettings.json")).StartUrl));
        const string admin = "https://www.sp1e.se/admin/?panel=sir-david";
        const string pair = "http://127.0.0.1:4318/__connect/?origin=https%3A%2F%2Fwww.sp1e.se";
        Check("Exact local pairing accepted from Admin", NavigationPolicy.ValidPairing(pair, admin));
        Check("Pairing rejected from public page", !NavigationPolicy.ValidPairing(pair, "https://www.sp1e.se/"));
        Check("Pairing cannot cross site origin", !NavigationPolicy.ValidPairing(pair, "https://sp1e.se/admin/"));
        foreach (var invalid in new[] { pair + "&extra=1", pair + "#fragment", pair.Replace("4318", "4319"), pair.Replace("127.0.0.1", "localhost"), pair.Replace("/__connect/", "/__agents/jobs"), pair.Replace("www.sp1e.se", "evil.example"), pair.Replace("http://", "http://user:password@") })
            Check("Reject invalid pairing " + invalid, !NavigationPolicy.ValidPairing(invalid, admin));
        Check("Admin autoplay allowed", PermissionPolicy.State(CoreWebView2PermissionKind.Autoplay, "https://www.sp1e.se", admin) == CoreWebView2PermissionState.Allow);
        Check("Canonical Admin autoplay allowed", PermissionPolicy.State(CoreWebView2PermissionKind.Autoplay, "https://sp1e.se/admin/", "https://sp1e.se/admin/") == CoreWebView2PermissionState.Allow);
        foreach (var requester in new[] { "https://evil.example", "http://127.0.0.1:4318", "https://sp1e.se", "https://user:password@www.sp1e.se", "https://www.sp1e.se:8443" })
            Check("Autoplay requester denied " + requester, PermissionPolicy.State(CoreWebView2PermissionKind.Autoplay, requester, admin) == CoreWebView2PermissionState.Deny);
        foreach (var page in new[] { "https://www.sp1e.se/", pair, "https://www.sp1e.se/portal/" })
            Check("Autoplay outside Admin denied " + page, PermissionPolicy.State(CoreWebView2PermissionKind.Autoplay, "https://www.sp1e.se", page) == CoreWebView2PermissionState.Deny);
        foreach (var kind in Enum.GetValues<CoreWebView2PermissionKind>().Where(kind => kind != CoreWebView2PermissionKind.Autoplay))
            Check("Other permission denied " + kind, PermissionPolicy.State(kind, "https://www.sp1e.se", admin) == CoreWebView2PermissionState.Deny);
        var scratch = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(reportPath))!, "self-test-window.json");
        new WindowPreferences(800, 700, true).Save(scratch);
        Check("Window preferences survive restart", WindowPreferences.Load(scratch) == new WindowPreferences(800, 700, true));
        File.Delete(scratch);
        Check("Missing preferences use default", WindowPreferences.Load(scratch) == new WindowPreferences());
        const string nativeAdmin = "https://sp1e.se/admin/?panel=sir-david";
        const string ready = "{\"type\":\"sir-david-ready\"}";
        Check("Reminder handshake accepts exact Admin document", ReminderPolicy.Parse(nativeAdmin, nativeAdmin, ready)?.Type == "ready");
        foreach (var source in new[] { "https://evil.example/admin/", "https://www.sp1e.se/admin/", "https://sp1e.se/", "http://127.0.0.1:4318/" })
            Check("Reminder source denied " + source, ReminderPolicy.Parse(source, nativeAdmin, ready) is null);
        foreach (var payload in new[] { "[]", "{}", "{\"type\":\"sir-david-ready\",\"command\":\"run\"}", "{\"type\":\"sir-david-preferences\",\"notifications\":\"yes\"}", "{\"type\":\"sir-david-ready\",\"type\":\"sir-david-ready\"}", new string('x',1025) })
            Check("Invalid reminder payload denied " + payload.Length, ReminderPolicy.Parse(nativeAdmin, nativeAdmin, payload) is null);
        Check("Nested Admin document cannot use native reminder bridge", ReminderPolicy.Parse("https://sp1e.se/admin/other", "https://sp1e.se/admin/other", ready) is null);
        Check("Notifications accept bool only", ReminderPolicy.Parse(nativeAdmin,nativeAdmin,"{\"type\":\"sir-david-preferences\",\"notifications\":true}")?.Notifications == true);
        Check("Reminder accepts bounded claim", ReminderPolicy.Parse(nativeAdmin,nativeAdmin,"{\"type\":\"sir-david-reminder\",\"claimId\":\"11111111-1111-4111-8111-111111111111\",\"title\":\"Sir David\",\"body\":\"Open planner\"}")?.Type == "reminder");
        string runtime;
        try { runtime = CoreWebView2Environment.GetAvailableBrowserVersionString(); if (requireRuntime) Check("WebView2 runtime installed", !string.IsNullOrEmpty(runtime)); }
        catch { runtime = "unavailable"; if (requireRuntime) Check("WebView2 runtime installed", false); }
        File.WriteAllText(reportPath, JsonSerializer.Serialize(new { application = Program.Name, failed, runtime, results }, new JsonSerializerOptions { WriteIndented = true }));
        Environment.ExitCode = failed == 0 ? 0 : 1;
    }
}

