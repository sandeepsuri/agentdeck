import AVFoundation
import CryptoKit
import Security
import SwiftUI
import UserNotifications

/**
 * What this phone keeps: its credential, how to reach the Mac directly and
 * (issue #90) through the relay, and the private half of its channel key.
 * No task data. Phones saved before #90 have only `base` and `credential`.
 */
struct SavedPhone: Codable {
    let base: URL?
    let credential: String
    var relay: RelayLink?
    var phoneKey: String?

    init(base: URL?, credential: String, relay: RelayLink? = nil, phoneKey: String? = nil) {
        self.base = base; self.credential = credential; self.relay = relay; self.phoneKey = phoneKey
    }

    var channelKey: Curve25519.KeyAgreement.PrivateKey? {
        phoneKey.flatMap { Data(base64URL: $0) }.flatMap { try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: $0) }
    }
}

enum PhoneKeychain {
    static let service = "dev.agentdeck.owner-phone"
    static func load() -> SavedPhone? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                    kSecAttrAccount as String: "owner", kSecReturnData as String: true,
                                    kSecMatchLimit as String: kSecMatchLimitOne]
        var value: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &value) == errSecSuccess,
              let data = value as? Data else { return nil }
        return try? JSONDecoder().decode(SavedPhone.self, from: data)
    }
    static func save(_ phone: SavedPhone) throws {
        remove()
        let data = try JSONEncoder().encode(phone)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                    kSecAttrAccount as String: "owner", kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
                                    kSecValueData as String: data]
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw PhoneError.message("Keychain could not save this phone (\(status)).") }
    }
    static func remove() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                       kSecAttrAccount as String: "owner"] as CFDictionary)
    }
}

private enum PhoneError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}

/**
 * A pairing QR code. `base` is the Mac over Tailscale; `relay` (issue #90) is
 * the Mac through the relay, with the Mac's channel key read here by camera
 * so the relay cannot substitute another. At least one is present.
 */
struct PairLink {
    let base: URL?; let relay: RelayLink?; let id: String; let secret: String
    init(_ text: String) throws {
        let invalid = PhoneError.message("Invalid AgentDeck pairing QR code.")
        guard let url = URLComponents(string: text), url.scheme == "agentdeck", url.host == "pair",
              let id = url.queryItems?.first(where: { $0.name == "id" })?.value, !id.isEmpty,
              let secret = url.queryItems?.first(where: { $0.name == "secret" })?.value, !secret.isEmpty
        else { throw invalid }
        let item = { (name: String) in url.queryItems?.first(where: { $0.name == name })?.value }
        var base: URL?
        if let rawBase = item("base") {
            guard let parsed = URL(string: rawBase), parsed.scheme == "http",
                  let host = parsed.host, host.lowercased().hasSuffix(".ts.net"),
                  parsed.user == nil, parsed.password == nil, parsed.query == nil, parsed.fragment == nil,
                  parsed.path.isEmpty || parsed.path == "/" else { throw invalid }
            base = parsed
        }
        var relay: RelayLink?
        if let rawRelay = item("relay") {
            guard let relayURL = URL(string: rawRelay), let host = relayURL.host,
                  relayURL.scheme == "wss" || (relayURL.scheme == "ws" && (host == "127.0.0.1" || host == "localhost")),
                  relayURL.user == nil, relayURL.query == nil, relayURL.fragment == nil,
                  let mailbox = item("mailbox"), mailbox.count == 32, mailbox.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }),
                  let mac = item("mac"), Data(base64URL: mac)?.count == 32 else { throw invalid }
            relay = RelayLink(url: relayURL, mailbox: mailbox, macKey: mac)
        }
        guard base != nil || relay != nil else { throw invalid }
        self.base = base; self.relay = relay; self.id = id; self.secret = secret
    }
}

private struct JoinResult: Decodable { let nonce: String; let code: String }
private struct CollectResult: Decodable { let pending: Bool?; let credential: String?; let relay: RelayLink? }
private struct EnrollResult: Decodable { let relay: RelayLink? }
private struct PushToken: Encodable { let token: String; let environment: String }

/** Receives the APNs token; the phone registers only once paired (issue #90 pointer pushes). */
final class PhoneAppDelegate: NSObject, UIApplicationDelegate {
    static var onToken: ((String) -> Void)?
    static var latestToken: String?

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        PhoneAppDelegate.latestToken = token
        PhoneAppDelegate.onToken?(token)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {}
}

@MainActor private final class PhoneModel: ObservableObject {
    /** Present while this phone holds a credential; it follows the Mac's tasks (issue #87). */
    @Published var companion: CompanionModel?
    @Published var scanning = false
    @Published var code: String?
    @Published var error: String?
    @Published var waiting = false
    private var pair: PairLink?
    private var pairing: CompanionClient?
    private var pairingKey: Curve25519.KeyAgreement.PrivateKey?
    private var nonce: String?

    init() {
        PhoneAppDelegate.onToken = { [weak self] token in Task { @MainActor in await self?.sendPushToken(token) } }
        reconnect()
    }

    private func client(for phone: SavedPhone) -> CompanionClient {
        let relay = phone.relay.flatMap { link in phone.channelKey.map { RelayTransport(link: link, phoneKey: $0) } }
        return CompanionClient(base: phone.base, credential: phone.credential, relay: relay)
    }

    func reconnect() {
        guard let phone = PhoneKeychain.load() else { companion = nil; return }
        companion = CompanionModel(client: client(for: phone)) { [weak self] in
            PhoneKeychain.remove()
            self?.companion = nil
            self?.error = "This phone was revoked on the Mac. Pair it again to continue."
        }
        error = nil
        Task { await enroll(phone) }
        registerForPushes()
    }

    /**
     * Over a direct connection only: gives the Mac this phone's channel key (a
     * phone paired before the relay has none yet) and learns the relay address,
     * which may have been set up or changed since pairing.
     */
    private func enroll(_ phone: SavedPhone) async {
        guard let base = phone.base else { return }
        var updated = phone
        if updated.channelKey == nil {
            // Kept before the Mac hears of it, so the Mac never holds a key this phone lost.
            updated.phoneKey = Curve25519.KeyAgreement.PrivateKey().rawRepresentation.base64URL
            guard (try? PhoneKeychain.save(updated)) != nil else { return }
        }
        guard let key = updated.channelKey else { return }
        var request = URLRequest(url: base.appending(path: "api/owner-pairing/relay-key"))
        request.httpMethod = "POST"
        request.timeoutInterval = 4
        request.setValue(phone.credential, forHTTPHeaderField: "x-agentdeck-token")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["publicKey": key.publicKey.rawRepresentation.base64URL])
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let result = try? JSONDecoder().decode(EnrollResult.self, from: data) else { return }
        updated.relay = result.relay ?? updated.relay
        // A new key or relay address means the companion must be rebuilt to use them.
        guard updated.relay != phone.relay || updated.phoneKey != phone.phoneKey else { return }
        try? PhoneKeychain.save(updated)
        companion?.stop()
        reconnect()
    }

    private func registerForPushes() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
        }
        if let token = PhoneAppDelegate.latestToken { Task { await sendPushToken(token) } }
    }

    private func sendPushToken(_ token: String) async {
        guard let phone = PhoneKeychain.load() else { return }
        #if DEBUG
        let environment = "sandbox"
        #else
        let environment = "production"
        #endif
        let _: [String: Bool]? = try? await client(for: phone).post("api/owner-pairing/push-token", PushToken(token: token, environment: environment))
    }

    func scan(_ text: String) {
        scanning = false
        do {
            let link = try PairLink(text)
            let key = Curve25519.KeyAgreement.PrivateKey()
            pair = link
            pairingKey = key
            pairing = CompanionClient(base: link.base, credential: "", relay: link.relay.map { RelayTransport(link: $0, phoneKey: key) })
            Task { await join() }
        } catch { self.error = error.localizedDescription }
    }

    /** A pairing request, directly or through the relay; a refusal carries the Mac's own reason. */
    private func request<T: Decodable>(_ path: String, _ body: [String: String]) async throws -> T {
        guard let pairing else { throw PhoneError.message("Scan the pairing QR code again.") }
        let (status, data): (Int, Data)
        do { (status, data) = try await pairing.exchange(path, method: "POST", body: try JSONSerialization.data(withJSONObject: body)) }
        catch { throw PhoneError.message("Can't reach the Mac. Check that AgentDeck is open, then scan again.") }
        guard (200..<300).contains(status) else {
            let reason = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw PhoneError.message(reason ?? "AgentDeck refused the request.")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func join() async {
        guard let pair, let pairingKey else { return }
        do {
            let joined: JoinResult = try await request("api/owner-pairing/join", [
                "id": pair.id, "secret": pair.secret, "label": UIDevice.current.name,
                "publicKey": pairingKey.publicKey.rawRepresentation.base64URL,
            ])
            nonce = joined.nonce; code = joined.code; error = nil
        } catch { self.error = error.localizedDescription }
    }

    func confirm() async {
        guard let pair, let nonce, let code, let pairingKey else { return }
        do {
            let _: [String: Bool] = try await request("api/owner-pairing/phone-confirm", ["id": pair.id, "nonce": nonce, "code": code])
            waiting = true
            for _ in 0..<120 {
                let result: CollectResult = try await request("api/owner-pairing/collect", ["id": pair.id, "nonce": nonce])
                if let credential = result.credential {
                    try PhoneKeychain.save(SavedPhone(base: pair.base, credential: credential, relay: result.relay ?? pair.relay,
                                                      phoneKey: pairingKey.rawRepresentation.base64URL))
                    self.pair = nil; self.nonce = nil; self.code = nil; waiting = false
                    self.pairing = nil; self.pairingKey = nil
                    reconnect()
                    return
                }
                try await Task.sleep(nanoseconds: 1_000_000_000)
            }
            throw PhoneError.message("Pairing expired. Start again on the Mac.")
        } catch { waiting = false; self.error = error.localizedDescription }
    }

    func forget() { companion?.stop(); PhoneKeychain.remove(); companion = nil }
}

private struct QRScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    func makeUIViewController(context: Context) -> UIViewController {
        let controller = UIViewController()
        let session = AVCaptureSession()
        guard let camera = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: camera), session.canAddInput(input) else { return controller }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return controller }
        session.addOutput(output)
        output.metadataObjectTypes = [.qr]
        output.setMetadataObjectsDelegate(context.coordinator, queue: .main)
        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = UIScreen.main.bounds
        controller.view.layer.addSublayer(preview)
        DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
        context.coordinator.session = session
        return controller
    }
    func updateUIViewController(_ controller: UIViewController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(onCode) }
    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        let onCode: (String) -> Void
        var session: AVCaptureSession?
        init(_ onCode: @escaping (String) -> Void) { self.onCode = onCode }
        func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
            guard let code = (objects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
            session?.stopRunning(); onCode(code)
        }
    }
}

@main struct AgentDeckPhoneApp: App {
    @UIApplicationDelegateAdaptor(PhoneAppDelegate.self) private var delegate
    @StateObject private var model = PhoneModel()
    var body: some Scene {
        WindowGroup {
            if let companion = model.companion {
                CompanionView(model: companion, onForget: model.forget)
            } else {
                NavigationStack {
                    ScrollView {
                        VStack(spacing: 16) {
                            if let code = model.code {
                                Text("Compare this code with the Mac").font(.headline)
                                Text(code).font(.largeTitle.monospacedDigit())
                                    .accessibilityLabel(code.map(String.init).joined(separator: " "))
                                Button("Same code on both devices — confirm here") { Task { await model.confirm() } }
                                    .buttonStyle(.borderedProminent).disabled(model.waiting)
                                if model.waiting { ProgressView("Waiting for Mac confirmation…") }
                            } else {
                                Text("Pair this phone").font(.headline)
                                Text("On your Mac, open AgentDeck › Settings › Owner phones › Pair a phone, then scan the code it shows.")
                                    .multilineTextAlignment(.center)
                                Button("Scan pairing QR on Mac") { model.scanning = true }.buttonStyle(.borderedProminent)
                            }
                            if let error = model.error { Text(error).foregroundStyle(.red).multilineTextAlignment(.center) }
                        }
                        .padding()
                    }
                    .navigationTitle("AgentDeck Phone")
                    .sheet(isPresented: $model.scanning) { QRScanner(onCode: model.scan).ignoresSafeArea() }
                }
                .onOpenURL { model.scan($0.absoluteString) }
            }
        }
    }
}
