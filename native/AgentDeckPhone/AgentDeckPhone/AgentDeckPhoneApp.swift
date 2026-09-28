import AVFoundation
import Security
import SwiftUI

struct SavedPhone: Codable { let base: URL; let credential: String }

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

struct PairLink {
    let base: URL; let id: String; let secret: String
    init(_ text: String) throws {
        guard let url = URLComponents(string: text), url.scheme == "agentdeck", url.host == "pair",
              let rawBase = url.queryItems?.first(where: { $0.name == "base" })?.value,
              let base = URL(string: rawBase), base.scheme == "http",
              let host = base.host, host.lowercased().hasSuffix(".ts.net"),
              base.user == nil, base.password == nil, base.query == nil, base.fragment == nil,
              base.path.isEmpty || base.path == "/",
              let id = url.queryItems?.first(where: { $0.name == "id" })?.value, !id.isEmpty,
              let secret = url.queryItems?.first(where: { $0.name == "secret" })?.value, !secret.isEmpty
        else { throw PhoneError.message("Invalid AgentDeck pairing QR code.") }
        self.base = base; self.id = id; self.secret = secret
    }
}

private struct JoinResult: Decodable { let nonce: String; let code: String }
private struct CollectResult: Decodable { let pending: Bool?; let credential: String? }
private struct Connection: Decodable { let kind: String; let capabilities: [String] }
private struct Session: Decodable, Identifiable { let id: String; let name: String?; let status: String }

@MainActor private final class PhoneModel: ObservableObject {
    @Published var saved = PhoneKeychain.load() != nil
    @Published var connected = false
    @Published var scanning = false
    @Published var code: String?
    @Published var sessions: [Session] = []
    @Published var error: String?
    @Published var waiting = false
    private var pair: PairLink?
    private var nonce: String?

    init() { Task { await reconnect() } }

    private func request<T: Decodable>(_ base: URL, _ path: String, body: [String: String]? = nil, credential: String? = nil) async throws -> T {
        var req = URLRequest(url: base.appending(path: path))
        req.timeoutInterval = 10
        if let credential { req.setValue(credential, forHTTPHeaderField: "x-agentdeck-token") }
        if let body {
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            throw PhoneError.message("AgentDeck refused the request. Check the Mac and Tailscale connection.")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    func reconnect() async {
        guard let phone = PhoneKeychain.load() else { saved = false; connected = false; return }
        do {
            let connection: Connection = try await request(phone.base, "api/connection", credential: phone.credential)
            guard connection.kind == "remote", !connection.capabilities.isEmpty else {
                PhoneKeychain.remove(); saved = false; connected = false
                error = "This phone was revoked. Pair it again on the Mac."
                return
            }
            sessions = try await request(phone.base, "api/sessions", credential: phone.credential)
            saved = true; connected = true; error = nil
        } catch {
            connected = false
            self.error = "Mac unavailable. The saved credential will be retried."
        }
    }

    func scan(_ text: String) {
        scanning = false
        do { pair = try PairLink(text); Task { await join() } }
        catch { self.error = error.localizedDescription }
    }

    private func join() async {
        guard let pair else { return }
        do {
            let joined: JoinResult = try await request(pair.base, "api/owner-pairing/join", body: [
                "id": pair.id, "secret": pair.secret, "label": UIDevice.current.name,
            ])
            nonce = joined.nonce; code = joined.code; error = nil
        } catch { self.error = error.localizedDescription }
    }

    func confirm() async {
        guard let pair, let nonce, let code else { return }
        do {
            let _: [String: Bool] = try await request(pair.base, "api/owner-pairing/phone-confirm", body: ["id": pair.id, "nonce": nonce, "code": code])
            waiting = true
            for _ in 0..<120 {
                let result: CollectResult = try await request(pair.base, "api/owner-pairing/collect", body: ["id": pair.id, "nonce": nonce])
                if let credential = result.credential {
                    try PhoneKeychain.save(SavedPhone(base: pair.base, credential: credential))
                    self.pair = nil; self.nonce = nil; self.code = nil; waiting = false
                    await reconnect()
                    return
                }
                try await Task.sleep(nanoseconds: 1_000_000_000)
            }
            throw PhoneError.message("Pairing expired. Start again on the Mac.")
        } catch { waiting = false; self.error = error.localizedDescription }
    }

    func forget() { PhoneKeychain.remove(); saved = false; connected = false; sessions = [] }
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
    @StateObject private var model = PhoneModel()
    var body: some Scene {
        WindowGroup {
            NavigationStack {
                VStack(spacing: 16) {
                    if model.connected {
                        Text("Connected to your Mac").font(.headline)
                        Button("Refresh") { Task { await model.reconnect() } }
                        List(model.sessions) { session in
                            VStack(alignment: .leading) { Text(session.name ?? session.id); Text(session.status).font(.caption) }
                        }
                        Button("Forget this phone") { model.forget() }
                    } else if let code = model.code {
                        Text("Compare this code with the Mac").font(.headline)
                        Text(code).font(.largeTitle.monospacedDigit())
                        Button("Same code on both devices — confirm here") { Task { await model.confirm() } }.disabled(model.waiting)
                        if model.waiting { ProgressView("Waiting for Mac confirmation…") }
                    } else {
                        Text(model.saved ? "Mac unavailable" : "Pair this phone").font(.headline)
                        if model.saved { Button("Reconnect") { Task { await model.reconnect() } } }
                        Button("Scan pairing QR on Mac") { model.scanning = true }
                    }
                    if let error = model.error { Text(error).foregroundStyle(.red) }
                }
                .padding()
                .navigationTitle("AgentDeck Phone")
                .sheet(isPresented: $model.scanning) { QRScanner(onCode: model.scan).ignoresSafeArea() }
                .onOpenURL { model.scan($0.absoluteString) }
            }
        }
    }
}
