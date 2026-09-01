import AppKit
import Combine
import Foundation
import UserNotifications

@MainActor
final class CompanionStore: ObservableObject {
    @Published private(set) var agents: [CompanionAgent] = []
    @Published private(set) var attention: [AttentionItem] = []
    /// Ticket 07: managed Run approval/input requests — a distinct list from
    /// `attention` (Session attention) so NotchView can render/regress-test
    /// the two independently, per AC6.
    @Published private(set) var runAttention: [RunAttentionItem] = []
    @Published private(set) var connected = false
    @Published private(set) var uiVisible = false
    @Published private(set) var hovered = false
    @Published private(set) var pinned = false
    @Published private(set) var attentionExpanded = false
    @Published private(set) var attentionGlow = false
    @Published private(set) var preferences = CompanionPreferences.load()

    let port: Int
    var onShowSettings: (() -> Void)?

    private var socket: URLSessionWebSocketTask?
    private var reconnectWork: DispatchWorkItem?
    private var attentionWork: DispatchWorkItem?
    private var glowWork: DispatchWorkItem?
    private var hoverWork: DispatchWorkItem?
    private var announcedAttentionIds = Set<String>()
    weak var notifications: NotificationCoordinator?

    init(port: Int, initialAgents: [CompanionAgent] = [], initialRunAttention: [RunAttentionItem] = []) {
        self.port = port
        self.agents = initialAgents
        self.runAttention = initialRunAttention
    }

    var sortedAgents: [CompanionAgent] {
        sortedCompanionAgents(agents)
    }

    var repoGroups: [RepoGroup] {
        groupedCompanionAgents(agents)
    }

    var priorityAgent: CompanionAgent? {
        sortedAgents.first
    }

    var otherRunningCount: Int {
        otherRunningAgentCount(agents, hasPriorityAgent: priorityAgent != nil)
    }

    var isExpanded: Bool {
        companionShouldExpand(hovered: hovered, pinned: pinned, attentionExpanded: attentionExpanded)
    }

    var bodyHeight: CGFloat {
        NotchGeometry.bodyHeight(groups: repoGroups.count, agents: agents.count, runAttentionCount: runAttention.count)
    }

    func start() {
        fetchSnapshot()
        connect()
    }

    func stop() {
        reconnectWork?.cancel()
        attentionWork?.cancel()
        glowWork?.cancel()
        hoverWork?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
    }

    func setHovered(_ value: Bool) {
        hoverWork?.cancel()
        if value {
            hovered = true
            return
        }
        let work = DispatchWorkItem { [weak self] in self?.hovered = false }
        hoverWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18, execute: work)
    }

    func togglePinned() {
        pinned.toggle()
    }

    func showSettings() {
        onShowSettings?()
    }

    func setNotificationsEnabled(_ enabled: Bool) {
        preferences.notificationsEnabled = enabled
        UserDefaults.standard.set(enabled, forKey: "notificationsEnabled")
        objectWillChange.send()
    }

    func setAttentionExpansionEnabled(_ enabled: Bool) {
        preferences.attentionExpansionEnabled = enabled
        UserDefaults.standard.set(enabled, forKey: "attentionExpansionEnabled")
        objectWillChange.send()
    }

    func openSession(_ sessionId: String) {
        openAgentDeck([
            URLQueryItem(name: "session", value: sessionId),
            URLQueryItem(name: "view", value: "terminal"),
        ])
    }

    func openAllAgents() {
        openAgentDeck([URLQueryItem(name: "view", value: "operations")])
    }

    /// Ticket 07: deep-links to the Run so an operator can approve/deny or
    /// provide input in the full AgentDeck UI — the notch itself never
    /// resolves a Run attention request in place, same as openSession never
    /// answers a Session prompt in place, only navigates there.
    func openRun(_ runId: String) {
        openAgentDeck([
            URLQueryItem(name: "run", value: runId),
            URLQueryItem(name: "view", value: "operations"),
        ])
    }

    private func openAgentDeck(_ queryItems: [URLQueryItem]) {
        var components = URLComponents()
        components.scheme = "http"
        components.host = "127.0.0.1"
        components.port = port
        components.path = "/"
        components.queryItems = queryItems
        if let url = components.url { NSWorkspace.shared.open(url) }
    }

    private func triggerAttentionExpansion() {
        guard preferences.attentionExpansionEnabled else { return }
        attentionWork?.cancel()
        glowWork?.cancel()
        attentionExpanded = true
        attentionGlow = true
        let glow = DispatchWorkItem { [weak self] in self?.attentionGlow = false }
        glowWork = glow
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.2, execute: glow)
        let expansion = DispatchWorkItem { [weak self] in self?.attentionExpanded = false }
        attentionWork = expansion
        DispatchQueue.main.asyncAfter(deadline: .now() + 7, execute: expansion)
    }

    private func connect() {
        guard let url = URL(string: "ws://127.0.0.1:\(port)/ws") else { return }
        let socket = URLSession.shared.webSocketTask(with: url)
        self.socket = socket
        socket.resume()
        receive()
    }

    private func receive() {
        socket?.receive { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .success(let message):
                    self.connected = true
                    let data: Data?
                    switch message {
                    case .string(let text): data = text.data(using: .utf8)
                    case .data(let bytes): data = bytes
                    @unknown default: data = nil
                    }
                    if let data, let envelope = try? JSONDecoder().decode(ServerEnvelope.self, from: data) {
                        if let snapshot = envelope.snapshot { self.apply(snapshot, announce: true) }
                        if envelope.t == "ui_presence", let visible = envelope.visible {
                            self.uiVisible = visible
                        }
                    }
                    self.receive()
                case .failure:
                    self.connected = false
                    self.scheduleReconnect()
                }
            }
        }
    }

    private func scheduleReconnect() {
        reconnectWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.fetchSnapshot()
            self?.connect()
        }
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
            Task { @MainActor in
                self?.connected = true
                self?.apply(snapshot, announce: false)
            }
        }.resume()
    }

    private func apply(_ snapshot: CompanionSnapshot, announce: Bool) {
        agents = snapshot.agents
        attention = snapshot.attention
        runAttention = snapshot.runAttention
        uiVisible = snapshot.uiVisible
        guard announce else { return }
        notifications?.process(
            snapshot.attention,
            uiVisible: snapshot.uiVisible,
            enabled: preferences.notificationsEnabled
        )
        // Ticket 07: a pending Run attention request expands the notch the
        // same way a new Session attention item does — its own id namespace
        // ("run-attention-agentdeck.com/attentionId" would collide only in
        // the unlikely case a Session attention item shared the identical
        // raw id, which announcedAttentionIds already tolerates fine since
        // both are just "new id, never seen before" signals) — Session
        // notifications themselves stay exactly as before (no Run attention
        // system notification is sent here; NotchView surfaces it visually).
        let currentIds = Set(snapshot.attention.map(\.id)).union(snapshot.runAttention.map(\.id))
        let newIds = currentIds.subtracting(announcedAttentionIds)
        announcedAttentionIds.formUnion(currentIds)
        if !snapshot.uiVisible && !newIds.isEmpty {
            triggerAttentionExpansion()
        }
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
