import CoreGraphics
import Foundation

/// Issue #91: what the capture helper and AgentDeck's service agree on.
/// src/native/window-capture.ts reads the same frame layout and exit codes.
enum WindowViewFormat {
    /// Exit codes the service maps to why a capture ended.
    enum Exit: Int32 {
        case stopped = 0
        case usage = 2
        case permission = 3
        case windowGone = 4
        case stoppedAtMac = 5
        case failed = 6
    }

    /// Longest side of a frame sent to the phone, in pixels.
    static let maxSide: CGFloat = 1280
    /// A frame larger than this is re-encoded at lower quality; the service drops anything over its relay limit.
    static let targetBytes = 280 * 1024

    /// u32 BE jpeg length | u16 BE width | u16 BE height, then the jpeg bytes.
    static func frame(jpeg: Data, width: Int, height: Int) -> Data {
        var data = Data(capacity: 8 + jpeg.count)
        var length = UInt32(jpeg.count).bigEndian
        var w = UInt16(clamping: width).bigEndian
        var h = UInt16(clamping: height).bigEndian
        withUnsafeBytes(of: &length) { data.append(contentsOf: $0) }
        withUnsafeBytes(of: &w) { data.append(contentsOf: $0) }
        withUnsafeBytes(of: &h) { data.append(contentsOf: $0) }
        data.append(jpeg)
        return data
    }

    /// The pixel size to capture a window at: its backing size, scaled down so the longest side fits.
    static func captureSize(points: CGSize, scale: CGFloat) -> (width: Int, height: Int) {
        let pixels = CGSize(width: max(points.width, 1) * scale, height: max(points.height, 1) * scale)
        let factor = min(1, maxSide / max(pixels.width, pixels.height))
        return (max(Int((pixels.width * factor).rounded()), 2), max(Int((pixels.height * factor).rounded()), 2))
    }

    /// One window as the Mac lists it for the owner to choose.
    struct Listed: Encodable, Equatable {
        let id: UInt32
        let app: String
        let title: String
    }

    /// Windows worth offering: normal-layer, on screen, big enough to read, and not AgentDeck's own capture indicator.
    static func offerable(id: UInt32, app: String?, bundle: String?, title: String?, layer: Int, size: CGSize, ownBundle: String?) -> Listed? {
        guard layer == 0, size.width >= 120, size.height >= 80, let app, !app.isEmpty else { return nil }
        if let bundle, bundle == ownBundle || bundle == "com.agentdeck.window-view" { return nil }
        return Listed(id: id, app: app, title: title ?? "")
    }

    /// The indicator's text naming the one window being shown.
    static func indicatorText(app: String, title: String) -> String {
        let name = title.isEmpty ? app : "\(app) — \(title)"
        return "Your phone is viewing “\(name)”"
    }
}
