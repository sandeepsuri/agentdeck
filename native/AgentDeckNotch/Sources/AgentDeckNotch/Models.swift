import Foundation

enum AttentionKind: String, Codable, CaseIterable {
    case reply
    case actionRequired = "action_required"
    case responseRequired = "response_required"
}

enum NotchStatus: String, Codable, CaseIterable {
    case action
    case waiting
    case reply
    case working
    case starting
    case offline

    var priority: Int {
        switch self {
        case .action: return 0
        case .waiting: return 1
        case .reply: return 2
        case .working: return 3
        case .starting: return 4
        case .offline: return 5
        }
    }

    var label: String {
        switch self {
        case .action: return "ACTION REQUIRED"
        case .waiting: return "WAITING"
        case .reply: return "NEW REPLY"
        case .working: return "WORKING"
        case .starting: return "STARTING"
        case .offline: return "OFFLINE"
        }
    }

    var isAttention: Bool {
        self == .action || self == .waiting || self == .reply
    }

    var showsCornerAlert: Bool {
        self == .waiting || self == .reply
    }
}

// Kept in the wire model during the additive protocol migration.
struct AgentSession: Codable, Identifiable, Equatable {
    let id: String
    let origin: String
    let agent: String
    let name: String?
    let taskId: String?
    let repoId: String?
    let cwd: String
    let branch: String?
    let worktreePath: String?
    let startedAt: String
    let lastActivityAt: String
    let status: String
    let statusSource: String
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
    let name: String
    let repo: String
    let repoName: String
    let task: String
    let branch: String?
    let progress: Double?
    let status: NotchStatus
    let updatedAt: String
    let attentionId: String?
}

/// Ticket 07: mirrors src/types.ts's RunAttentionKind exactly — a managed
/// Run's runtime approval/input request awaiting an operator decision.
enum RunAttentionKind: String, Codable, CaseIterable {
    case approval
    case input
}

/// Mirrors src/types.ts's RunAttentionItem — the same minimal, remote-safe
/// shape GET /api/runs/attention and the WS companion_snapshot both carry
/// (never the Repository path, budget, or full spec). `attentionId` is the
/// stable correlation the companion hands back to AgentDeck to resolve it
/// (openRun deep-links there; this build never resolves it itself).
struct RunAttentionItem: Codable, Identifiable, Equatable {
    let runId: String
    let attentionId: String
    let objective: String
    let kind: RunAttentionKind
    let reason: String
    let requestedAt: String
    var id: String { attentionId }
}

struct CompanionSnapshot: Codable, Equatable {
    let sessions: [AgentSession]
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

struct RepoGroup: Identifiable, Equatable {
    let name: String
    let agents: [CompanionAgent]
    var id: String { name }
}

func sortedCompanionAgents(_ agents: [CompanionAgent]) -> [CompanionAgent] {
    agents.sorted {
        $0.status.priority == $1.status.priority
            ? $0.updatedAt > $1.updatedAt
            : $0.status.priority < $1.status.priority
    }
}

func groupedCompanionAgents(_ agents: [CompanionAgent]) -> [RepoGroup] {
    let sorted = sortedCompanionAgents(agents)
    var names: [String] = []
    var buckets: [String: [CompanionAgent]] = [:]
    for agent in sorted {
        if buckets[agent.repoName] == nil { names.append(agent.repoName) }
        buckets[agent.repoName, default: []].append(agent)
    }
    return names.map { RepoGroup(name: $0, agents: buckets[$0] ?? []) }
}

func companionShouldExpand(hovered: Bool, pinned: Bool, attentionExpanded: Bool) -> Bool {
    hovered || pinned || attentionExpanded
}

func otherRunningAgentCount(_ agents: [CompanionAgent], hasPriorityAgent: Bool) -> Int {
    max(0, agents.filter { $0.status != .offline }.count - (hasPriorityAgent ? 1 : 0))
}

enum NotchGeometry {
    static let compactWidth: CGFloat = 384
    static let compactHeight: CGFloat = 34
    static let menuWidth: CGFloat = 214
    static let menuHeight: CGFloat = 30
    static let expandedWidth: CGFloat = 604
    static let maximumBodyHeight: CGFloat = 680

    /// `runAttentionCount` defaults to 0 so every pre-ticket-07 call site
    /// (and testExpandedBodyHeightIsContentDrivenAndCapped, which asserts
    /// exact heights with the 2-argument form) keeps its existing behavior
    /// unchanged.
    static func bodyHeight(groups: Int, agents: Int, runAttentionCount: Int = 0) -> CGFloat {
        let header: CGFloat = 62
        let groupHeaders = CGFloat(groups) * 34
        let rows = CGFloat(agents) * 76
        let rowGaps = CGFloat(max(0, agents - groups)) * 6
        let runAttentionRows = CGFloat(runAttentionCount) * 56
        let footer: CGFloat = 44
        let padding: CGFloat = 14
        return min(maximumBodyHeight, max(180, header + groupHeaders + rows + rowGaps + runAttentionRows + footer + padding))
    }
}

struct CompanionPreferences: Equatable {
    var notificationsEnabled: Bool
    var attentionExpansionEnabled: Bool

    static func load() -> CompanionPreferences {
        let defaults = UserDefaults.standard
        let notifications = defaults.object(forKey: "notificationsEnabled") as? Bool ?? true
        let expansion = defaults.object(forKey: "attentionExpansionEnabled") as? Bool ?? true
        return CompanionPreferences(
            notificationsEnabled: notifications,
            attentionExpansionEnabled: expansion
        )
    }
}
