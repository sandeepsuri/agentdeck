import CoreGraphics
import Foundation
import XCTest
@testable import AgentDeckWindowView

final class WindowViewFormatTests: XCTestCase {
    func testFrameHeaderMatchesTheServiceDecoder() {
        let frame = WindowViewFormat.frame(jpeg: Data([0xFF, 0xD8, 0xFF]), width: 640, height: 480)
        XCTAssertEqual([UInt8](frame), [0, 0, 0, 3, 0x02, 0x80, 0x01, 0xE0, 0xFF, 0xD8, 0xFF])
    }

    func testCaptureSizeKeepsAspectAndFitsTheLongestSide() {
        let size = WindowViewFormat.captureSize(points: CGSize(width: 1600, height: 1000), scale: 2)
        XCTAssertEqual(size.width, 1280)
        XCTAssertEqual(size.height, 800)
        let small = WindowViewFormat.captureSize(points: CGSize(width: 300, height: 200), scale: 2)
        XCTAssertEqual(small.width, 600)
        XCTAssertEqual(small.height, 400)
    }

    func testOffersOnlyNormalReadableWindowsAndNeverTheIndicator() {
        let size = CGSize(width: 800, height: 600)
        XCTAssertEqual(
            WindowViewFormat.offerable(id: 7, app: "Notes", bundle: "com.apple.Notes", title: nil, layer: 0, size: size, ownBundle: nil),
            .init(id: 7, app: "Notes", title: "")
        )
        XCTAssertNil(WindowViewFormat.offerable(id: 8, app: "Dock", bundle: "com.apple.dock", title: "", layer: 20, size: size, ownBundle: nil))
        XCTAssertNil(WindowViewFormat.offerable(id: 9, app: "Tiny", bundle: "x", title: "", layer: 0, size: CGSize(width: 40, height: 40), ownBundle: nil))
        XCTAssertNil(WindowViewFormat.offerable(id: 10, app: "AgentDeck Window View", bundle: "com.agentdeck.window-view", title: "", layer: 0, size: size, ownBundle: nil))
    }

    func testIndicatorNamesTheWindow() {
        XCTAssertEqual(WindowViewFormat.indicatorText(app: "Safari", title: "Docs"), "Your phone is viewing “Safari — Docs”")
        XCTAssertEqual(WindowViewFormat.indicatorText(app: "Notes", title: ""), "Your phone is viewing “Notes”")
    }
}
