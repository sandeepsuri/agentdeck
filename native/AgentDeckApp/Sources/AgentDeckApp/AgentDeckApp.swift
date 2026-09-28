import AppKit
import SwiftUI
import WebKit

@main
struct AgentDeckApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    var body: some Scene { Settings { EmptyView() } }
}

struct ServiceLifecycle {
    enum Status: Equatable {
        case starting
        case ready
        case failed(String)
    }

    private(set) var status: Status = .starting
    private(set) var active = false
    private var startedAt = Date()
    private var consecutiveFailures = 0

    mutating func start(at date: Date = Date()) {
        active = true
        startedAt = date
        consecutiveFailures = 0
        status = .starting
    }

    mutating func fail(_ reason: String) {
        guard active else { return }
        status = .failed(reason)
    }

    mutating func healthCheck(succeeded: Bool, at date: Date = Date(), port: Int) {
        guard active else { return }
        if succeeded {
            consecutiveFailures = 0
            status = .ready
        } else {
            consecutiveFailures += 1
            if date.timeIntervalSince(startedAt) > 20 ||
                (status == .ready && consecutiveFailures >= 3) {
                status = .failed("The local service is not responding. Port \(port) may be in use, or startup may have failed.")
            }
        }
    }

    mutating func stop() { active = false }
}

/// A Finder-launched app inherits launchd's minimal PATH, which hides the
/// Homebrew, nvm and ~/.local tools (codex, claude, git, node) a terminal sees.
enum ServiceEnvironment {
    static let marker = "__AGENTDECK_PATH__"

    /// PATH printed between markers by the user's login shell; nil when absent.
    static func parseLoginPath(_ output: String) -> String? {
        let parts = output.components(separatedBy: marker)
        guard parts.count >= 3 else { return nil }
        let value = parts[1].trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    static func mergedPath(loginPath: String?, inherited: String?) -> String {
        let entries = (loginPath ?? "").split(separator: ":").map(String.init)
            + (inherited ?? "").split(separator: ":").map(String.init)
            + ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        var seen = Set<String>()
        return entries.filter { !$0.isEmpty && seen.insert($0).inserted }.joined(separator: ":")
    }

    static func make(base: [String: String], loginPath: String?) -> [String: String] {
        var environment = base
        environment["PATH"] = mergedPath(loginPath: loginPath, inherited: base["PATH"])
        environment["NODE_ENV"] = "production"
        environment["AGENTDECK_LOCAL_ONLY"] = "1"
        // The service's working folder is meaningless here, so it must not
        // derive which folders to scan from it.
        environment["AGENTDECK_LAUNCHED_BY_APP"] = "1"
        return environment
    }

    /// Ask the login shell for its PATH, bounded so a slow profile can't block startup.
    static func loginShellPath(shell: String?, timeout: TimeInterval = 3) -> String? {
        let child = Process()
        child.executableURL = URL(fileURLWithPath: shell.flatMap { $0.isEmpty ? nil : $0 } ?? "/bin/zsh")
        child.arguments = ["-ilc", "printf '%s%s%s' \(marker) \"$PATH\" \(marker)"]
        let pipe = Pipe()
        child.standardOutput = pipe
        child.standardError = FileHandle.nullDevice
        child.standardInput = FileHandle.nullDevice
        do { try child.run() } catch { return nil }
        let deadline = Date().addingTimeInterval(timeout)
        while child.isRunning && Date() < deadline { usleep(20_000) }
        if child.isRunning { child.terminate(); return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return parseLoginPath(String(decoding: data, as: UTF8.self))
    }
}

@MainActor
final class ServiceController: ObservableObject {
    @Published private(set) var status: ServiceLifecycle.Status = .starting
    private var process: Process?
    private var timer: Timer?
    private var lifecycle = ServiceLifecycle()
    private let logURL: URL
    private var loginPath: String?
    let serviceURL: URL

    init() {
        let config = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".agentdeck/config.json")
        let settings = (try? Data(contentsOf: config))
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        let configuredPort = settings?["port"] as? Int
        let port = configuredPort.flatMap { (1...65535).contains($0) ? $0 : nil } ?? 4040
        serviceURL = URL(string: "http://127.0.0.1:\(port)")!
        let logs = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/AgentDeck", isDirectory: true)
        try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
        logURL = logs.appendingPathComponent("service.log")
    }

    func start() {
        stopProcess()
        lifecycle.start()
        status = lifecycle.status

        guard let resources = Bundle.main.resourceURL else {
            fail("The app resources are missing. Reinstall AgentDeck.")
            return
        }
        let service = resources.appendingPathComponent("service", isDirectory: true)
        let node = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/node")
        let entry = service.appendingPathComponent("bin/agentdeck.mjs")
        guard FileManager.default.isExecutableFile(atPath: node.path),
              FileManager.default.fileExists(atPath: entry.path) else {
            fail("The bundled service is incomplete. Reinstall AgentDeck.")
            return
        }

        let child = Process()
        child.executableURL = node
        child.arguments = [entry.path, "serve"]
        child.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        if loginPath == nil {
            loginPath = ServiceEnvironment.loginShellPath(shell: ProcessInfo.processInfo.environment["SHELL"])
        }
        child.environment = ServiceEnvironment.make(base: ProcessInfo.processInfo.environment, loginPath: loginPath)
        if let output = FileHandle(forWritingAtPath: logURL.path) {
            _ = try? output.seekToEnd()
            child.standardOutput = output
            child.standardError = output
        } else {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
            if let output = FileHandle(forWritingAtPath: logURL.path) {
                child.standardOutput = output
                child.standardError = output
            }
        }
        do {
            try child.run()
            process = child
            timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.checkHealth() }
            }
            checkHealth()
        } catch {
            fail("Could not launch the bundled service: \(error.localizedDescription)")
        }
    }

    private func fail(_ reason: String) {
        lifecycle.fail(reason)
        status = lifecycle.status
    }

    private func checkHealth() {
        guard let process else { return }
        if !process.isRunning {
            fail("The service stopped. Check the log, then try Repair Startup.")
            timer?.invalidate()
            return
        }
        URLSession.shared.dataTask(with: serviceURL.appendingPathComponent("api/health")) { [weak self] _, response, _ in
            Task { @MainActor in
                guard let self, self.process === process, process.isRunning else { return }
                self.lifecycle.healthCheck(succeeded: (response as? HTTPURLResponse)?.statusCode == 200,
                                           port: self.serviceURL.port ?? 4040)
                self.status = self.lifecycle.status
            }
        }.resume()
    }

    func repair() { start() }

    func openLog() { NSWorkspace.shared.open(logURL) }

    func openDataFolder() {
        NSWorkspace.shared.open(FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".agentdeck", isDirectory: true))
    }

    func stopProcess() {
        lifecycle.stop()
        timer?.invalidate()
        timer = nil
        if let process, process.isRunning {
            process.terminate()
            let deadline = Date().addingTimeInterval(3)
            while process.isRunning && Date() < deadline {
                RunLoop.current.run(until: Date().addingTimeInterval(0.05))
            }
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
        process = nil
    }
}

private struct BrowserView: NSViewRepresentable {
    let url: URL
    func makeNSView(context: Context) -> WKWebView {
        let view = WKWebView()
        view.load(URLRequest(url: url))
        return view
    }
    func updateNSView(_ view: WKWebView, context: Context) {}
}

private struct MainView: View {
    @ObservedObject var service: ServiceController

    var body: some View {
        Group {
            switch service.status {
            case .starting:
                VStack(spacing: 16) {
                    ProgressView()
                    Text("Starting AgentDeck…")
                }
            case .ready:
                BrowserView(url: service.serviceURL)
            case .failed(let reason):
                VStack(spacing: 16) {
                    Image(systemName: "exclamationmark.triangle").font(.largeTitle)
                    Text("AgentDeck could not start").font(.title2)
                    Text(reason).multilineTextAlignment(.center).frame(maxWidth: 480)
                    HStack {
                        Button("Repair Startup") { service.repair() }
                        Button("Open Service Log") { service.openLog() }
                        Button("Open Data Folder") { service.openDataFolder() }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let service = ServiceController()
    private var window: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 760),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        window.title = "AgentDeck"
        window.minSize = NSSize(width: 800, height: 560)
        window.center()
        window.contentView = NSHostingView(rootView: MainView(service: service))
        window.makeKeyAndOrderFront(nil)
        self.window = window
        service.start()
    }

    func applicationWillTerminate(_ notification: Notification) { service.stopProcess() }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
