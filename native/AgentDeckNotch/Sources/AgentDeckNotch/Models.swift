import Foundation

enum AttentionKind: String, Codable { case reply, actionRequired = "action_required", responseRequired = "response_required" }
enum CompanionStatus: String, Codable {
    case action, waiting, reply, working, starting, offline
    var label: String {
        switch self {
        case .action, .waiting: return "Input needed"
        case .reply: return "New reply"
        case .working: return "Working"
        case .starting: return "Starting"
        case .offline: return "Reconnecting"
        }
    }
    var isAttention: Bool { self == .action || self == .waiting || self == .reply }
    var priority: Int {
        switch self { case .action: return 0; case .waiting: return 1; case .reply: return 2; case .working: return 3; case .starting: return 4; case .offline: return 5 }
    }
}

struct AttentionItem: Codable, Identifiable, Equatable {
    let id: String
    let kind: AttentionKind
    let sessionId: String
    let agent: String
    let sessionName: String
    let repo: String
    let repoName: String
    let occurredAt: String
    let message: String?
    let branch: String?
}
struct CompanionAgent: Codable, Identifiable, Equatable {
    let id: String
    let agent: String
    let usageSessionId: String?
    let name: String
    let sessionName: String
    let repo: String
    let repoName: String
    let task: String
    let branch: String?
    let status: CompanionStatus
    let updatedAt: String
    let attentionId: String?
}
enum RunAttentionKind: String, Codable { case approval, input }
struct RunAttentionItem: Codable, Identifiable, Equatable {
    let runId: String
    let attentionId: String
    let objective: String
    let kind: RunAttentionKind
    let reason: String
    let requestedAt: String
    var id: String { attentionId }
}
struct CompanionSnapshot: Codable {
    let attention: [AttentionItem]
    let agents: [CompanionAgent]
    let runAttention: [RunAttentionItem]
    let uiVisible: Bool
}
struct ServerEnvelope: Codable {
    let t: String
    let snapshot: CompanionSnapshot?
    let visible: Bool?
}

struct TokenTotals: Codable, Equatable {
    let totalTokens: Int
    let costUsd: Double
    let unpricedTokens: Int
    let events: Int
    var costLabel: String {
        if events == 0 { return "No indexed usage this month" }
        return estimatedCostLabel(costUsd: costUsd, unpricedTokens: unpricedTokens)
    }
}
struct UsageSession: Codable, Equatable {
    let provider: String
    let sessionId: String
    let models: [String]
    let totalTokens: Int
    let costUsd: Double
    let unpricedTokens: Int
    var modelLabel: String { models.count > 1 ? "Multiple models" : (models.first ?? "Model unavailable") }
    var costLabel: String {
        estimatedCostLabel(costUsd: costUsd, unpricedTokens: unpricedTokens)
    }
}
private func estimatedCostLabel(costUsd: Double, unpricedTokens: Int) -> String {
    let amount = String(format: "$%.2f", costUsd)
    return unpricedTokens > 0 ? "Partial API estimate \(amount)" : "API estimate \(amount)"
}
struct CompanionUsage: Codable {
    let month: TokenTotals
    let sessions: [UsageSession]
    let indexedAt: String?
    func session(for agent: CompanionAgent) -> UsageSession? {
        guard let id = agent.usageSessionId else { return nil }
        return sessions.first { $0.provider == agent.agent && $0.sessionId == id }
    }
}

struct CompanionDisplay {
    let attention: [CompanionAgent]
    let progress: [CompanionAgent]
    let runs: [RunAttentionItem]
    var actionableCount: Int { attention.count + runs.count }
    var runningCount: Int { progress.filter { $0.status == .working || $0.status == .starting }.count }
    init(agents: [CompanionAgent], runs: [RunAttentionItem], connected: Bool) {
        let unique = Dictionary(agents.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let sorted = unique.values.sorted { $0.status.priority == $1.status.priority ? $0.updatedAt > $1.updatedAt : $0.status.priority < $1.status.priority }
        self.attention = connected ? sorted.filter { $0.status.isAttention } : []
        self.progress = connected ? sorted.filter { $0.status == .working || $0.status == .starting } : []
        self.runs = connected ? runs : []
    }
}
enum CompanionGeometry {
    static let menuWidth: CGFloat = 128
    static let menuHeight: CGFloat = 26
    static let popoverWidth: CGFloat = 420
    static let popoverHeight: CGFloat = 560
    static func popoverSize(in visibleFrame: CGRect) -> CGSize {
        CGSize(width: min(popoverWidth, max(1, visibleFrame.width - 16)),
               height: min(popoverHeight, max(1, visibleFrame.height - 16)))
    }
}
struct CompanionPreferences {
    var notificationsEnabled: Bool
    static func load() -> Self { .init(notificationsEnabled: UserDefaults.standard.object(forKey: "notificationsEnabled") as? Bool ?? true) }
}
