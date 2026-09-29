import CryptoKit
import XCTest
@testable import AgentDeckPhone

/**
 * Issue #90: the phone's channel must agree byte for byte with the Mac's
 * (src/relay/channel.ts). These values come from that implementation with the
 * same fixed keys; channel.test.ts pins the same vector on the Mac side.
 */
final class RelayChannelTests: XCTestCase {
    private func key(_ byte: UInt8) throws -> Curve25519.KeyAgreement.PrivateKey {
        try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: Data(repeating: byte, count: 32))
    }

    private let macKey = "pOCSkrZRwni5dyxWn1-puxPZBrRqtoyd-dwrRAn4ogk"
    private let welcome = "eyJ2IjoxLCJlIjoickFHeUlKNkdOVS00VXlON1hlRDAtckU4Zjh2ME02WWNBWk5wWVhfczhRcyIsInAiOiI5UE14QjZ0NWhJdG5ON2g3d2d0MzhUZzZ2aGthYXdFIn0"

    func testMatchesTheMacsHandshakeAndFrames() throws {
        XCTAssertEqual(try key(1).publicKey.rawRepresentation.base64URL, macKey)
        XCTAssertEqual(try key(2).publicKey.rawRepresentation.base64URL, "zo060cy2M-x7cMF4FKXHbs0CloUFDTRHRboFhw5YfVk")

        let hello = try RelayChannel.hello(phone: key(2), macKey: macKey, ephemeral: key(3))
        let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(Data(base64URL: hello.message))) as? [String: Any])
        XCTAssertEqual(fields["v"] as? Int, 1)
        XCTAssertEqual(fields["e"] as? String, "Xf7dO2vUf2-ijuFdlp1bsOpTd01Ii9r53xxuASSz7yI")
        XCTAssertEqual(fields["s"] as? String, "ZKfSOavptoagiEIJzIEJj3sAKMIpC8r-Pa-o0x-_Ffdnl-4uqJrINyD2leEQ8tXa")
        XCTAssertEqual(fields["p"] as? String, "yZElDo1MESVvx7ZCVFosx9rBOsEX")

        let session = try RelayChannel.finish(hello.state, reply: welcome)
        XCTAssertEqual(try session.seal("vector"), "9R-5lzkybPbEPOD-BcRRehmzg5-gyg")
        XCTAssertEqual(try session.open("t2YQ2pg9kR6SiVSyFvEKz6ubxW_N3-xs"), "from-mac")
    }

    func testRefusesAnAnswerFromAnyMacButTheOnePaired() throws {
        let otherMac = try key(9).publicKey.rawRepresentation.base64URL
        let hello = try RelayChannel.hello(phone: key(2), macKey: otherMac, ephemeral: key(3))
        XCTAssertThrowsError(try RelayChannel.finish(hello.state, reply: welcome))
    }

    func testRefusesATamperedOrReplayedFrame() throws {
        let hello = try RelayChannel.hello(phone: key(2), macKey: macKey, ephemeral: key(3))
        let session = try RelayChannel.finish(hello.state, reply: welcome)
        var tampered = try XCTUnwrap(Data(base64URL: "t2YQ2pg9kR6SiVSyFvEKz6ubxW_N3-xs"))
        tampered[0] ^= 1
        XCTAssertThrowsError(try session.open(tampered.base64URL))
        XCTAssertEqual(try session.open("t2YQ2pg9kR6SiVSyFvEKz6ubxW_N3-xs"), "from-mac")
        XCTAssertThrowsError(try session.open("t2YQ2pg9kR6SiVSyFvEKz6ubxW_N3-xs"))
    }
}
