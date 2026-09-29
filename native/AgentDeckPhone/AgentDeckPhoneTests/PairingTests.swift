import XCTest
@testable import AgentDeckPhone

final class PairingTests: XCTestCase {
    func testPairingLinkAcceptsTailnetChallengeAndRejectsOtherSchemes() throws {
        let link = try PairLink("agentdeck://pair?base=http%3A%2F%2Fmac.tailnet.ts.net%3A4040&id=challenge-1&secret=once")
        XCTAssertEqual(link.base?.absoluteString, "http://mac.tailnet.ts.net:4040")
        XCTAssertNil(link.relay)
        XCTAssertEqual(link.id, "challenge-1")
        XCTAssertEqual(link.secret, "once")
        XCTAssertThrowsError(try PairLink("https://example.com/?secret=once"))
        XCTAssertThrowsError(try PairLink("agentdeck://pair?base=http%3A%2F%2Fevil.example%3A4040&id=challenge-1&secret=once"))
        XCTAssertThrowsError(try PairLink("agentdeck://pair?base=http%3A%2F%2Fmac.tailnet.ts.net%3A4040&id=challenge-1"))
    }

    /** Issue #90: a code from a Mac without Tailscale carries only the relay and the Mac's key. */
    func testPairingLinkAcceptsARelayChallengeWithTheMacsKey() throws {
        let mac = Data(repeating: 1, count: 32).base64URL
        let mailbox = String(repeating: "a", count: 32)
        let link = try PairLink("agentdeck://pair?id=c1&secret=once&relay=wss%3A%2F%2Frelay.example.com&mailbox=\(mailbox)&mac=\(mac)")
        XCTAssertNil(link.base)
        XCTAssertEqual(link.relay, RelayLink(url: URL(string: "wss://relay.example.com")!, mailbox: mailbox, macKey: mac))
        XCTAssertThrowsError(try PairLink("agentdeck://pair?id=c1&secret=once&relay=ws%3A%2F%2Frelay.example.com&mailbox=\(mailbox)&mac=\(mac)"))
        XCTAssertThrowsError(try PairLink("agentdeck://pair?id=c1&secret=once&relay=wss%3A%2F%2Frelay.example.com&mailbox=\(mailbox)&mac=short"))
        XCTAssertThrowsError(try PairLink("agentdeck://pair?id=c1&secret=once"))
    }

    func testAPhoneSavedBeforeTheRelayStillLoads() throws {
        let old = try JSONDecoder().decode(SavedPhone.self, from: Data(#"{"base":"http://mac.tailnet.ts.net:4040","credential":"c"}"#.utf8))
        XCTAssertEqual(old.credential, "c")
        XCTAssertNil(old.relay)
        XCTAssertNil(old.channelKey)
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
