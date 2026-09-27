import AppKit
import SwiftUI
import WebKit

@main
struct AgentDeckApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    var body: some Scene { Settings { EmptyView() } }
}

@MainActor
final class ServiceController: ObservableObject {
    enum Status: Equatable {
        case starting
        case ready
        case failed(String)
    }

    @Published private(set) var status: Status = .starting
    private var process: Process?
    private var timer: Timer?
    private var startedAt = Date()
    private var consecutiveFailures = 0
    private let logURL: URL
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
        status = .starting
        startedAt = Date()
        consecutiveFailures = 0

        guard let resources = Bundle.main.resourceURL else {
            status = .failed("The app resources are missing. Reinstall AgentDeck.")
            return
        }
        let service = resources.appendingPathComponent("service", isDirectory: true)
        let node = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/node")
        let entry = service.appendingPathComponent("bin/agentdeck.mjs")
        guard FileManager.default.isExecutableFile(atPath: node.path),
              FileManager.default.fileExists(atPath: entry.path) else {
            status = .failed("The bundled service is incomplete. Reinstall AgentDeck.")
            return
        }

        let child = Process()
        child.executableURL = node
        child.arguments = [entry.path, "serve"]
        child.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        var environment = ProcessInfo.processInfo.environment
        environment["NODE_ENV"] = "production"
        environment["AGENTDECK_LOCAL_ONLY"] = "1"
        child.environment = environment
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
            status = .failed("Could not launch the bundled service: \(error.localizedDescription)")
        }
    }

    private func checkHealth() {
        guard let process else { return }
        if !process.isRunning {
            status = .failed("The service stopped during startup. Check the log, then try Repair Startup.")
            timer?.invalidate()
            return
        }
        URLSession.shared.dataTask(with: serviceURL.appendingPathComponent("api/health")) { [weak self] _, response, _ in
            Task { @MainActor in
                guard let self, self.process === process, process.isRunning else { return }
                if (response as? HTTPURLResponse)?.statusCode == 200 {
                    self.consecutiveFailures = 0
                    self.status = .ready
                } else {
                    self.consecutiveFailures += 1
                    if Date().timeIntervalSince(self.startedAt) > 20 ||
                        (self.status == .ready && self.consecutiveFailures >= 3) {
                    self.status = .failed("The local service is not responding. Port \(self.serviceURL.port ?? 4040) may be in use, or startup may have failed.")
                    }
                }
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
