import CryptoKit
import XCTest
@testable import AgentDeckPhone

/**
 * Issue #90: the phone's relay transport against a real relay and Mac link
 * (scripts/relay-phone-fixture.ts). Skipped unless RELAY_FIXTURE holds the
 * link that script prints; pass it as TEST_RUNNER_RELAY_FIXTURE to xcodebuild.
 */
final class RelayTransportTests: XCTestCase {
    private func fixture() throws -> RelayLink {
        guard let json = ProcessInfo.processInfo.environment["RELAY_FIXTURE"] else {
            throw XCTSkip("Run scripts/relay-phone-fixture.ts and pass TEST_RUNNER_RELAY_FIXTURE to test against a real relay.")
        }
        return try JSONDecoder().decode(RelayLink.self, from: Data(json.utf8))
    }

    private func key(_ byte: UInt8) throws -> Curve25519.KeyAgreement.PrivateKey {
        try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: Data(repeating: byte, count: 32))
    }

    func testRequestsReachTheMacSealedAndAnswersComeBackInAnyOrder() async throws {
        let transport = RelayTransport(link: try fixture(), phoneKey: try key(2))
        async let first = transport.send(method: "GET", path: "api/personal/tasks", body: nil, credential: "cred")
        async let second = transport.send(method: "POST", path: "/api/personal/tasks", body: Data(#"{"kind":"pdf-inventory"}"#.utf8), credential: "cred")
        let (one, two) = try await (first, second)
        XCTAssertEqual(one.0, 200)
        let echoed = try XCTUnwrap(JSONSerialization.jsonObject(with: one.1) as? [String: Any])
        XCTAssertEqual(echoed["path"] as? String, "/api/personal/tasks")
        XCTAssertEqual(echoed["token"] as? String, "cred")
        let posted = try XCTUnwrap(JSONSerialization.jsonObject(with: two.1) as? [String: Any])
        XCTAssertEqual((posted["body"] as? [String: Any])?["kind"] as? String, "pdf-inventory")
        await transport.close()
    }

    func testAKeyTheMacNeverPairedIsRefused() async throws {
        let transport = RelayTransport(link: try fixture(), phoneKey: Curve25519.KeyAgreement.PrivateKey())
        let (status, _) = try await transport.send(method: "GET", path: "api/personal/tasks", body: nil, credential: "cred")
        XCTAssertEqual(status, 403)
        await transport.close()
    }

    func testAMacThatIsNotConnectedIsUnavailable() async throws {
        let link = try fixture()
        let offline = RelayLink(url: link.url, mailbox: String(repeating: "x", count: 32), macKey: link.macKey)
        do {
            _ = try await RelayTransport(link: offline, phoneKey: try key(2)).send(method: "GET", path: "api/personal/tasks", body: nil, credential: "cred")
            XCTFail("expected unavailable")
        } catch {
            XCTAssertEqual(error as? CompanionFailure, .unavailable)
        }
    }

    func testFallsBackToTheRelayWhenTheMacIsNotReachableDirectly() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubMac.self]
        StubMac.handler = nil
        let client = CompanionClient(base: URL(string: "http://mac.tailnet.ts.net:4040")!, credential: "cred",
                                     session: URLSession(configuration: configuration),
                                     relay: RelayTransport(link: try fixture(), phoneKey: try key(2)))
        let (status, _) = try await client.exchange("api/personal/tasks", method: "GET", body: nil)
        XCTAssertEqual(status, 200)
        XCTAssertTrue(client.route.preferRelay)
    }
}
