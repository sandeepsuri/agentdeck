import XCTest
@testable import AgentDeckApp

final class ServiceLifecycleTests: XCTestCase {
    func testStartupFailureAndRepair() {
        var lifecycle = ServiceLifecycle()
        let started = Date(timeIntervalSince1970: 0)
        lifecycle.start(at: started)
        lifecycle.healthCheck(succeeded: false, at: started.addingTimeInterval(21), port: 4040)
        guard case .failed(let reason) = lifecycle.status else { return XCTFail("Expected startup failure") }
        XCTAssertTrue(reason.contains("4040"))
        lifecycle.start(at: started.addingTimeInterval(30))
        XCTAssertEqual(lifecycle.status, .starting)
        lifecycle.healthCheck(succeeded: true, port: 4040)
        XCTAssertEqual(lifecycle.status, .ready)
    }

    func testHealthLossRequiresRepeatedFailuresAndRecovers() {
        var lifecycle = ServiceLifecycle()
        lifecycle.start()
        lifecycle.healthCheck(succeeded: true, port: 4040)
        lifecycle.healthCheck(succeeded: false, port: 4040)
        lifecycle.healthCheck(succeeded: false, port: 4040)
        XCTAssertEqual(lifecycle.status, .ready)
        lifecycle.healthCheck(succeeded: false, port: 4040)
        guard case .failed = lifecycle.status else { return XCTFail("Expected health failure") }
        lifecycle.healthCheck(succeeded: true, port: 4040)
        XCTAssertEqual(lifecycle.status, .ready)
    }

    func testShutdownIgnoresLateHealthAndFailureCallbacks() {
        var lifecycle = ServiceLifecycle()
        lifecycle.start()
        lifecycle.stop()
        lifecycle.healthCheck(succeeded: true, port: 4040)
        lifecycle.fail("late exit")
        XCTAssertEqual(lifecycle.status, .starting)
        XCTAssertFalse(lifecycle.active)
    }
}
