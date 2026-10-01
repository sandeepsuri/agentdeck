// Issue #91: AgentDeck's window-capture helper. The service runs it for
// each command:
//
//   permission            prints "granted" or "denied" (Screen Recording)
//   request-permission    asks macOS for Screen Recording, then prints as above
//   list                  prints the windows the owner may share, as JSON
//   capture <window id>   streams that one window as JPEG frames on stdout
//
// While capturing, a floating indicator names the window and offers Stop.
// Capture ends when stdin closes (the service stopped or went away), on
// Stop, when the window goes away, or when Screen Recording is withdrawn.
import AppKit
import CoreImage
import CoreMedia
import ScreenCaptureKit

func finish(_ code: WindowViewFormat.Exit, _ reason: String? = nil) -> Never {
    if let reason { FileHandle.standardError.write(Data((reason + "\n").utf8)) }
    exit(code.rawValue)
}

func printPermission() -> Never {
    print(CGPreflightScreenCaptureAccess() ? "granted" : "denied")
    finish(.stopped)
}

func isPermissionError(_ error: Error) -> Bool {
    (error as NSError).domain == SCStreamErrorDomain && (error as NSError).code == SCStreamError.Code.userDeclined.rawValue
}

func shareableContent() async throws -> SCShareableContent {
    try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
}

func listWindows() async -> Never {
    guard CGPreflightScreenCaptureAccess() else { finish(.permission, "permission-denied") }
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        let own = Bundle.main.bundleIdentifier
        let listed = content.windows.compactMap { window in
            WindowViewFormat.offerable(
                id: window.windowID,
                app: window.owningApplication?.applicationName,
                bundle: window.owningApplication?.bundleIdentifier,
                title: window.title,
                layer: window.windowLayer,
                size: window.frame.size,
                ownBundle: own
            )
        }
        FileHandle.standardOutput.write(try JSONEncoder().encode(listed))
        finish(.stopped)
    } catch {
        finish(isPermissionError(error) ? .permission : .failed, "list failed: \(error.localizedDescription)")
    }
}

/// Writes frames to the service, encoding each complete sample as JPEG.
final class FrameWriter: NSObject, SCStreamOutput, SCStreamDelegate {
    private let context = CIContext()
    private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid, let pixels = sampleBuffer.imageBuffer else { return }
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
           let raw = attachments.first?[.status] as? Int,
           SCFrameStatus(rawValue: raw) != .complete {
            return
        }
        // Lower quality, then size, until the frame fits one relay frame; the service drops anything larger.
        var image = CIImage(cvPixelBuffer: pixels)
        var jpeg = encode(image, 0.6)
        for _ in 0..<4 {
            guard let current = jpeg, current.count > WindowViewFormat.targetBytes else { break }
            jpeg = encode(image, 0.35)
            if let smaller = jpeg, smaller.count <= WindowViewFormat.targetBytes { break }
            image = image.transformed(by: CGAffineTransform(scaleX: 0.7, y: 0.7))
            jpeg = encode(image, 0.35)
        }
        guard let jpeg, jpeg.count <= WindowViewFormat.targetBytes else { return }
        let frame = WindowViewFormat.frame(jpeg: jpeg, width: Int(image.extent.width), height: Int(image.extent.height))
        do { try FileHandle.standardOutput.write(contentsOf: frame) }
        catch { finish(.stopped) } // The service closed the pipe.
    }

    private func encode(_ image: CIImage, _ quality: Double) -> Data? {
        context.jpegRepresentation(of: image, colorSpace: colorSpace, options: [
            CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): quality,
        ])
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        finish(isPermissionError(error) ? .permission : .windowGone, "capture stopped: \(error.localizedDescription)")
    }
}

/// The visible sign that a phone is viewing this Mac: it names the window and stays up for the whole capture.
@MainActor
final class Indicator: NSObject {
    private var panel: NSPanel?

    func show(app: String, title: String) {
        let label = NSTextField(labelWithString: WindowViewFormat.indicatorText(app: app, title: title))
        label.font = .systemFont(ofSize: 13, weight: .medium)
        label.lineBreakMode = .byTruncatingMiddle
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let dot = NSTextField(labelWithString: "●")
        dot.textColor = .systemRed
        let stop = NSButton(title: "Stop", target: self, action: #selector(stopAtMac))
        stop.bezelStyle = .rounded
        let row = NSStackView(views: [dot, label, stop])
        row.orientation = .horizontal
        row.spacing = 8
        row.edgeInsets = NSEdgeInsets(top: 8, left: 14, bottom: 8, right: 10)

        let background = NSVisualEffectView()
        background.material = .hudWindow
        background.state = .active
        background.wantsLayer = true
        background.layer?.cornerRadius = 12
        background.addSubview(row)
        row.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: background.leadingAnchor),
            row.trailingAnchor.constraint(equalTo: background.trailingAnchor),
            row.topAnchor.constraint(equalTo: background.topAnchor),
            row.bottomAnchor.constraint(equalTo: background.bottomAnchor),
        ])

        let width: CGFloat = 520
        let height: CGFloat = 44
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let frame = NSRect(x: screen.midX - width / 2, y: screen.maxY - height - 8, width: width, height: height)
        let panel = NSPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.contentView = background
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .statusBar
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = true
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        // Never part of any capture, including this one.
        panel.sharingType = .none
        panel.orderFrontRegardless()
        self.panel = panel
    }

    @objc private func stopAtMac() { finish(.stoppedAtMac, "stopped-at-mac") }
}

@MainActor
final class Capture {
    private let windowID: CGWindowID
    private let writer = FrameWriter()
    private let indicator = Indicator()
    private var stream: SCStream?
    private let queue = DispatchQueue(label: "agentdeck.window-view.frames")

    init(windowID: CGWindowID) { self.windowID = windowID }

    /// Starts the capture and then watches it for as long as the process runs.
    func run() async -> Never {
        guard CGPreflightScreenCaptureAccess() else { finish(.permission, "permission-denied") }
        let window: SCWindow
        do {
            guard let found = try await shareableContent().windows.first(where: { $0.windowID == windowID }) else {
                finish(.windowGone, "window-gone")
            }
            window = found
        } catch {
            finish(isPermissionError(error) ? .permission : .failed, "capture failed: \(error.localizedDescription)")
        }
        // The indicator is up before the first frame is taken.
        indicator.show(app: window.owningApplication?.applicationName ?? "A window", title: window.title ?? "")

        let configuration = SCStreamConfiguration()
        let scale = NSScreen.screens.map(\.backingScaleFactor).max() ?? 2
        let size = WindowViewFormat.captureSize(points: window.frame.size, scale: scale)
        configuration.width = size.width
        configuration.height = size.height
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 2)
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.showsCursor = false
        configuration.queueDepth = 3
        // Only this one window: never the desktop, other windows, or other apps.
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let stream = SCStream(filter: filter, configuration: configuration, delegate: writer)
        do {
            try stream.addStreamOutput(writer, type: .screen, sampleHandlerQueue: queue)
            try await stream.startCapture()
        } catch {
            finish(isPermissionError(error) ? .permission : .failed, "capture failed: \(error.localizedDescription)")
        }
        self.stream = stream
        await watch()
    }

    /// Ends the capture as soon as the window is gone or permission is withdrawn. Never returns.
    private func watch() async -> Never {
        while true {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard CGPreflightScreenCaptureAccess() else { finish(.permission, "permission-denied") }
            do {
                let windows = try await shareableContent().windows
                if !windows.contains(where: { $0.windowID == windowID }) { finish(.windowGone, "window-gone") }
            } catch {
                finish(isPermissionError(error) ? .permission : .failed, "watch failed: \(error.localizedDescription)")
            }
        }
    }
}

signal(SIGPIPE, SIG_IGN)
let arguments = CommandLine.arguments.dropFirst()
switch arguments.first {
case "permission":
    printPermission()
case "request-permission":
    _ = CGRequestScreenCaptureAccess()
    printPermission()
case "list":
    Task { await listWindows() }
    dispatchMain()
case "capture":
    guard let raw = arguments.dropFirst().first, let id = UInt32(raw), id > 0 else { finish(.usage, "usage: capture <window id>") }
    // The service holds our stdin; when it closes, the service is gone and so is this capture.
    Thread.detachNewThread {
        _ = FileHandle.standardInput.readDataToEndOfFile()
        finish(.stopped)
    }
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    Task { @MainActor in await Capture(windowID: id).run() }
    app.run()
default:
    finish(.usage, "usage: AgentDeckWindowView permission | request-permission | list | capture <window id>")
}
