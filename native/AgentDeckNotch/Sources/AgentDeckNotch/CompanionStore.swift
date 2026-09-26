import AppKit
import Combine
import Foundation
import UserNotifications

@MainActor
final class CompanionStore: ObservableObject {
    @Published private(set) var agents: [CompanionAgent] = []
    @Published private(set) var attention: [AttentionItem] = []
    @Published private(set) var runAttention: [RunAttentionItem] = []
    @Published private(set) var usage: CompanionUsage?
    @Published private(set) var connected = false
    @Published private(set) var uiVisible = false
    @Published private(set) var preferences = CompanionPreferences.load()
    let port: Int
    var onShowSettings: (() -> Void)?
    weak var notifications: NotificationCoordinator?
    private var socket: URLSessionWebSocketTask?
    private var reconnectWork: DispatchWorkItem?
    private var usageTimer: Timer?
    private var usageGeneration = 0

    init(port: Int, initialAgents: [CompanionAgent] = [], initialRunAttention: [RunAttentionItem] = []) {
        self.port = port
        agents = initialAgents
        runAttention = initialRunAttention
    }
    var display: CompanionDisplay { CompanionDisplay(agents: agents, runs: runAttention, connected: connected) }
    func start() {
        fetchSnapshot()
        connect()
        usageTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshUsage() }
        }
    }
    func stop() {
        reconnectWork?.cancel()
        usageTimer?.invalidate()
        socket?.cancel(with: .goingAway, reason: nil)
    }
    func showSettings() { onShowSettings?() }
    func setNotificationsEnabled(_ enabled: Bool) {
        preferences.notificationsEnabled = enabled
        UserDefaults.standard.set(enabled, forKey: "notificationsEnabled")
        objectWillChange.send()
    }
    func openSession(_ id: String) { openAgentDeck([URLQueryItem(name: "session", value: id), URLQueryItem(name: "view", value: "terminal")]) }
    func openRun(_ id: String) { openAgentDeck([URLQueryItem(name: "run", value: id), URLQueryItem(name: "view", value: "operations")]) }
    func openAllAgents() { openAgentDeck([URLQueryItem(name: "view", value: "operations")]) }
    private func openAgentDeck(_ items: [URLQueryItem]) {
        var url = URLComponents()
        url.scheme = "http"
        url.host = "127.0.0.1"
        url.port = port
        url.path = "/"
        url.queryItems = items
        if let destination = url.url { NSWorkspace.shared.open(destination) }
    }
    private func connect() {
        guard let url = URL(string: "ws://127.0.0.1:\(port)/ws") else { return }
        socket = URLSession.shared.webSocketTask(with: url)
        socket?.resume()
        receive()
    }
    private func receive() {
        socket?.receive { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .success(let message):
                    let data: Data?
                    switch message {
                    case .string(let text): data = text.data(using: .utf8)
                    case .data(let bytes): data = bytes
                    @unknown default: data = nil
                    }
                    if let data, let envelope = try? JSONDecoder().decode(ServerEnvelope.self, from: data) {
                        self.connected = true
                        if let snapshot = envelope.snapshot { self.apply(snapshot, announce: true) }
                        if envelope.t == "ui_presence", let visible = envelope.visible { self.uiVisible = visible }
                    }
                    self.receive()
                case .failure:
                    self.connected = false
                    self.usage = nil
                    self.scheduleReconnect()
                }
            }
        }
    }
    private func scheduleReconnect() {
        reconnectWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.fetchSnapshot(); self?.connect() }
        reconnectWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: work)
    }
    private func fetchSnapshot() {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/companion") else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let data, let snapshot = try? JSONDecoder().decode(CompanionSnapshot.self, from: data) else {
                Task { @MainActor in self?.connected = false }
                return
            }
            Task { @MainActor in self?.connected = true; self?.apply(snapshot, announce: false) }
        }.resume()
    }
    private func apply(_ snapshot: CompanionSnapshot, announce: Bool) {
        let previous = Set(agents.compactMap { agent in agent.usageSessionId.map { "\(agent.agent):\($0)" } })
        agents = snapshot.agents
        attention = snapshot.attention
        runAttention = snapshot.runAttention
        uiVisible = snapshot.uiVisible
        let current = Set(agents.compactMap { agent in agent.usageSessionId.map { "\(agent.agent):\($0)" } })
        if usage == nil || current != previous { refreshUsage() }
        if announce { notifications?.process(snapshot.attention, uiVisible: snapshot.uiVisible, enabled: preferences.notificationsEnabled) }
    }
    func refreshUsage() {
        guard connected, let url = URL(string: "http://127.0.0.1:\(port)/api/usage/companion") else { return }
        let refs = agents.compactMap { agent -> [String: String]? in
            guard let id = agent.usageSessionId else { return nil }
            return ["provider": agent.agent, "sessionId": id]
        }
        guard let body = try? JSONSerialization.data(withJSONObject: ["sessions": refs]) else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        usageGeneration += 1
        let generation = usageGeneration
        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            let result = data.flatMap { try? JSONDecoder().decode(CompanionUsage.self, from: $0) }
            Task { @MainActor in
                guard let self, generation == self.usageGeneration else { return }
                self.usage = result
            }
        }.resume()
    }
}

@MainActor
final class NotificationCoordinator: NSObject, UNUserNotificationCenterDelegate {
    private weak var store: CompanionStore?
    private var seen = Set(UserDefaults.standard.stringArray(forKey: "notifiedAttention") ?? [])

    init(store: CompanionStore) {
        self.store = store
        super.init()
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    func process(_ items: [AttentionItem], uiVisible: Bool, enabled: Bool) {
        guard enabled && !uiVisible else { return }
        for item in items where !seen.contains(item.id) {
            seen.insert(item.id)
            let content = UNMutableNotificationContent()
            content.title = "AgentDeck"
            switch item.kind {
            case .reply:
                content.body = "New reply from \(agentName(item.agent)) in \(item.repoName)"
            case .actionRequired:
                content.body = "\(agentName(item.agent)) needs an action in \(item.repoName)"
            case .responseRequired:
                content.body = "\(agentName(item.agent)) is waiting for your response in \(item.repoName)"
            }
            content.sound = .default
            content.userInfo = ["sessionId": item.sessionId]
            UNUserNotificationCenter.current().add(
                UNNotificationRequest(identifier: item.id, content: content, trigger: nil)
            )
        }
        UserDefaults.standard.set(Array(seen.suffix(500)), forKey: "notifiedAttention")
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let sessionId = response.notification.request.content.userInfo["sessionId"] as? String
        if let sessionId {
            await MainActor.run { self.store?.openSession(sessionId) }
        }
    }

    private func agentName(_ agent: String) -> String {
        agent == "claude" ? "Claude Code" : "Codex"
    }
}
