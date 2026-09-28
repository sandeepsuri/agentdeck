import XCTest
@testable import AgentDeckApp

final class ServiceEnvironmentTests: XCTestCase {
    func testParsesPathBetweenMarkersIgnoringShellNoise() {
        let output = "Welcome!\n__AGENTDECK_PATH__/Users/me/.nvm/versions/node/v24/bin:/usr/bin__AGENTDECK_PATH__"
        XCTAssertEqual(ServiceEnvironment.parseLoginPath(output), "/Users/me/.nvm/versions/node/v24/bin:/usr/bin")
        XCTAssertNil(ServiceEnvironment.parseLoginPath("no markers"))
        XCTAssertNil(ServiceEnvironment.parseLoginPath("__AGENTDECK_PATH____AGENTDECK_PATH__"))
    }

    func testLoginPathComesFirstAndFallbacksAreAlwaysPresent() {
        let merged = ServiceEnvironment.mergedPath(loginPath: "/nvm/bin:/usr/bin", inherited: "/usr/bin:/bin")
            .split(separator: ":").map(String.init)
        XCTAssertEqual(merged.first, "/nvm/bin")
        XCTAssertTrue(merged.contains("/opt/homebrew/bin"))
        XCTAssertEqual(Set(merged).count, merged.count)
    }

    func testMissingLoginPathStillAddsHomebrew() {
        let environment = ServiceEnvironment.make(base: ["PATH": "/usr/bin:/bin", "HOME": "/Users/me"], loginPath: nil)
        XCTAssertTrue(environment["PATH"]!.contains("/opt/homebrew/bin"))
        XCTAssertEqual(environment["AGENTDECK_LAUNCHED_BY_APP"], "1")
        XCTAssertEqual(environment["AGENTDECK_LOCAL_ONLY"], "1")
        XCTAssertEqual(environment["HOME"], "/Users/me")
    }

    func testRelaunchesOnlyOnTheRequestedRestartExit() {
        XCTAssertTrue(ServiceEnvironment.wantsRestart(reason: .exit, status: 75))
        XCTAssertFalse(ServiceEnvironment.wantsRestart(reason: .exit, status: 1))
        XCTAssertFalse(ServiceEnvironment.wantsRestart(reason: .uncaughtSignal, status: 75))
    }
}
