import XCTest
@testable import AgentDeckPhone

final class PairingTests: XCTestCase {
    func testPairingLinkAcceptsTailnetChallengeAndRejectsOtherSchemes() throws {
        let link = try PairLink("agentdeck://pair?base=http%3A%2F%2Fmac.tailnet.ts.net%3A4040&id=challenge-1&secret=once")
        XCTAssertEqual(link.base.absoluteString, "http://mac.tailnet.ts.net:4040")
        XCTAssertEqual(link.id, "challenge-1")
        XCTAssertEqual(link.secret, "once")
        XCTAssertThrowsError(try PairLink("https://example.com/?secret=once"))
        XCTAssertThrowsError(try PairLink("agentdeck://pair?base=http%3A%2F%2Fevil.example%3A4040&id=challenge-1&secret=once"))
        XCTAssertThrowsError(try PairLink("agentdeck://pair?base=http%3A%2F%2Fmac.tailnet.ts.net%3A4040&id=challenge-1"))
    }

    func testCredentialSurvivesKeychainReloadAndCanBeRemoved() throws {
        PhoneKeychain.remove()
        defer { PhoneKeychain.remove() }
        let saved = SavedPhone(base: try XCTUnwrap(URL(string: "http://mac.tailnet.ts.net:4040")), credential: "test-bearer-value")
        try PhoneKeychain.save(saved)
        XCTAssertEqual(PhoneKeychain.load()?.credential, "test-bearer-value")
        XCTAssertEqual(PhoneKeychain.load()?.base, saved.base)
        PhoneKeychain.remove()
        XCTAssertNil(PhoneKeychain.load())
    }
}
