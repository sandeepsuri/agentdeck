import CryptoKit
import Foundation

// Issue #90: this phone's end of the channel to the Mac through the relay.
// It mirrors src/relay/channel.ts exactly; RelayChannelTests checks both
// against the same published vector. The relay forwards these frames and can
// open none of them: the phone learned the Mac's key from the pairing QR code
// by camera, and only that Mac can answer the handshake.

enum RelayChannelError: Error, Equatable {
    case malformed
    case authentication
}

extension Data {
    init?(base64URL value: String) {
        var text = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        text += String(repeating: "=", count: (4 - text.count % 4) % 4)
        self.init(base64Encoded: text)
    }

    var base64URL: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

/** How to reach the Mac through the relay, from the pairing QR code or the Mac. */
struct RelayLink: Codable, Equatable {
    let url: URL
    let mailbox: String
    let macKey: String
}

/** One connection's keys: one per direction, with counters that must advance by exactly one. */
final class ChannelSession {
    private let sendKey: SymmetricKey
    private let receiveKey: SymmetricKey
    private var sent: UInt64 = 0
    private var received: UInt64 = 0

    init(sendKey: SymmetricKey, receiveKey: SymmetricKey) {
        self.sendKey = sendKey
        self.receiveKey = receiveKey
    }

    private static func nonce(_ counter: UInt64) -> Data {
        var data = Data(count: 4)
        withUnsafeBytes(of: counter.bigEndian) { data.append(contentsOf: $0) }
        return data
    }

    func seal(_ text: String) throws -> String {
        let sealed = try RelayChannel.seal(sendKey, ChannelSession.nonce(sent), Data(text.utf8), Data())
        sent += 1
        return sealed.base64URL
    }

    func open(_ frame: String) throws -> String {
        guard let data = Data(base64URL: frame) else { throw RelayChannelError.malformed }
        let plain = try RelayChannel.open(receiveKey, ChannelSession.nonce(received), data, Data())
        received += 1
        guard let text = String(data: plain, encoding: .utf8) else { throw RelayChannelError.malformed }
        return text
    }
}

struct RelayHandshake {
    let staticKey: Curve25519.KeyAgreement.PrivateKey
    let ephemeral: Curve25519.KeyAgreement.PrivateKey
    let dh1: Data
    let dh2: Data
    let hash: Data
}

enum RelayChannel {
    static let label = "agentdeck-relay/1"

    static func sha256(_ parts: Data...) -> Data { Data(SHA256.hash(data: parts.reduce(Data(), +))) }

    static func hkdf(_ ikm: Data, _ salt: Data, _ info: String, _ length: Int = 32) -> SymmetricKey {
        HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: ikm), salt: salt, info: Data(info.utf8), outputByteCount: length)
    }

    static func dh(_ privateKey: Curve25519.KeyAgreement.PrivateKey, _ publicRaw: Data) throws -> Data {
        guard publicRaw.count == 32 else { throw RelayChannelError.malformed }
        let publicKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: publicRaw)
        return try privateKey.sharedSecretFromKeyAgreement(with: publicKey).withUnsafeBytes { Data($0) }
    }

    static func seal(_ key: SymmetricKey, _ nonce: Data, _ plaintext: Data, _ aad: Data) throws -> Data {
        let box = try ChaChaPoly.seal(plaintext, using: key, nonce: ChaChaPoly.Nonce(data: nonce), authenticating: aad)
        return box.ciphertext + box.tag
    }

    static func open(_ key: SymmetricKey, _ nonce: Data, _ sealed: Data, _ aad: Data) throws -> Data {
        guard sealed.count >= 16 else { throw RelayChannelError.malformed }
        do {
            let box = try ChaChaPoly.SealedBox(nonce: ChaChaPoly.Nonce(data: nonce), ciphertext: sealed.prefix(sealed.count - 16), tag: sealed.suffix(16))
            return try ChaChaPoly.open(box, using: key, authenticating: aad)
        } catch { throw RelayChannelError.authentication }
    }

    private static func encode(_ fields: [String: Any]) throws -> String {
        try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]).base64URL
    }

    private static func decode(_ message: String, _ keys: [String]) throws -> [String: Data] {
        guard let data = Data(base64URL: message),
              let fields = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              fields["v"] as? Int == 1 else { throw RelayChannelError.malformed }
        var out: [String: Data] = [:]
        for key in keys {
            guard let text = fields[key] as? String, let value = Data(base64URL: text) else { throw RelayChannelError.malformed }
            out[key] = value
        }
        return out
    }

    /** The phone's first message; `ephemeral` is fixed only by the test vector. */
    static func hello(phone: Curve25519.KeyAgreement.PrivateKey, macKey: String,
                      ephemeral: Curve25519.KeyAgreement.PrivateKey = .init()) throws -> (message: String, state: RelayHandshake) {
        guard let mac = Data(base64URL: macKey), mac.count == 32 else { throw RelayChannelError.malformed }
        let e = ephemeral.publicKey.rawRepresentation
        let h1 = sha256(sha256(Data(label.utf8), mac), e)
        let dh1 = try dh(ephemeral, mac)
        let sealedStatic = try seal(hkdf(dh1, h1, "k1"), Data(count: 12), phone.publicKey.rawRepresentation, h1)
        let h2 = sha256(h1, sealedStatic)
        let dh2 = try dh(phone, mac)
        let proof = try seal(hkdf(dh1 + dh2, h2, "k2"), Data(count: 12), Data("hello".utf8), h2)
        let h3 = sha256(h2, proof)
        let message = try encode(["v": 1, "e": e.base64URL, "s": sealedStatic.base64URL, "p": proof.base64URL])
        return (message, RelayHandshake(staticKey: phone, ephemeral: ephemeral, dh1: dh1, dh2: dh2, hash: h3))
    }

    /** Checks the Mac's answer: only the Mac this phone paired with can make it. */
    static func finish(_ state: RelayHandshake, reply: String) throws -> ChannelSession {
        let fields = try decode(reply, ["e", "p"])
        guard let em = fields["e"], em.count == 32, let confirm = fields["p"] else { throw RelayChannelError.malformed }
        let h4 = sha256(state.hash, em)
        let ikm = state.dh1 + state.dh2 + (try dh(state.ephemeral, em)) + (try dh(state.staticKey, em))
        _ = try open(hkdf(ikm, h4, "k3"), Data(count: 12), confirm, h4)
        let okm = hkdf(ikm, sha256(h4, confirm), "session", 64).withUnsafeBytes { Data($0) }
        return ChannelSession(sendKey: SymmetricKey(data: okm.prefix(32)), receiveKey: SymmetricKey(data: okm.suffix(32)))
    }
}

/**
 * Requests to the Mac through the relay: the same REST calls the phone makes
 * directly, sealed, with answers matched by id. Any close, refusal, frame
 * that does not open, or answer that does not come within `requestTimeout`
 * ends the connection, and callers see `.unavailable` rather than waiting on
 * a link that went quiet.
 */
actor RelayTransport {
    private let link: RelayLink
    private let phoneKey: Curve25519.KeyAgreement.PrivateKey
    private let urlSession: URLSession
    private var socket: URLSessionWebSocketTask?
    private var session: ChannelSession?
    private var connecting: Task<Void, Error>?
    private var pending: [Int: CheckedContinuation<(Int, Data), Error>] = [:]
    private var nextId = 1
    private let requestTimeout: Double

    init(link: RelayLink, phoneKey: Curve25519.KeyAgreement.PrivateKey, urlSession: URLSession = .shared, requestTimeout: Double = 15) {
        self.link = link
        self.phoneKey = phoneKey
        self.urlSession = urlSession
        self.requestTimeout = requestTimeout
    }

    func send(method: String, path: String, body: Data?, credential: String?) async throws -> (Int, Data) {
        try await connect()
        guard let socket, let session else { throw CompanionFailure.unavailable }
        var request: [String: Any] = ["method": method, "path": path.hasPrefix("/") ? path : "/\(path)"]
        if let body, let json = try? JSONSerialization.jsonObject(with: body, options: [.fragmentsAllowed]) { request["body"] = json }
        if let credential { request["token"] = credential }
        let id = nextId
        nextId += 1
        request["id"] = id
        let frame = try session.seal(String(decoding: try JSONSerialization.data(withJSONObject: request), as: UTF8.self))
        let timeout = requestTimeout
        let watchdog = Task { [weak self] in
            try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            await self?.expire(id)
        }
        defer { watchdog.cancel() }
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            socket.send(.string(frame)) { [weak self] error in
                guard error != nil, let self else { return }
                Task { await self.reset() }
            }
        }
    }

    /** An answer that never came: the link is not trustworthy, so start again. */
    private func expire(_ id: Int) {
        if pending[id] != nil { reset() }
    }

    func close() { reset() }

    private func connect() async throws {
        if session != nil { return }
        if let connecting { return try await connecting.value }
        let task = Task { try await handshake() }
        connecting = task
        defer { connecting = nil }
        do { try await task.value } catch { reset(); throw CompanionFailure.unavailable }
    }

    private func handshake() async throws {
        var url = link.url.appending(path: "v1/phone/\(link.mailbox)")
        if url.scheme == "https" { url = URL(string: url.absoluteString.replacingOccurrences(of: "https://", with: "wss://")) ?? url }
        let socket = urlSession.webSocketTask(with: url)
        self.socket = socket
        socket.resume()
        let hello = try RelayChannel.hello(phone: phoneKey, macKey: link.macKey)
        try await socket.send(.string(hello.message))
        let reply = try await withTimeout(seconds: 10) { try await socket.receive() }
        guard case .string(let text) = reply else { throw RelayChannelError.malformed }
        session = try RelayChannel.finish(hello.state, reply: text)
        receiveLoop(socket)
    }

    private func receiveLoop(_ socket: URLSessionWebSocketTask) {
        Task { [weak self] in
            while true {
                guard let message = try? await socket.receive() else { await self?.reset(); return }
                guard case .string(let frame) = message else { await self?.reset(); return }
                await self?.deliver(frame)
            }
        }
    }

    private func deliver(_ frame: String) {
        guard let session, let text = try? session.open(frame),
              let reply = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              let id = reply["id"] as? Int, let status = reply["status"] as? Int else { reset(); return }
        let body = reply["body"].flatMap { try? JSONSerialization.data(withJSONObject: $0, options: [.fragmentsAllowed]) } ?? Data()
        pending.removeValue(forKey: id)?.resume(returning: (status, body))
    }

    private func reset() {
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        session = nil
        let waiting = pending
        pending = [:]
        for continuation in waiting.values { continuation.resume(throwing: CompanionFailure.unavailable) }
    }
}

private func withTimeout<T: Sendable>(seconds: Double, _ work: @escaping @Sendable () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await work() }
        group.addTask {
            try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            throw CompanionFailure.unavailable
        }
        let first = try await group.next()!
        group.cancelAll()
        return first
    }
}
