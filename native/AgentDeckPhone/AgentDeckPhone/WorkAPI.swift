import Foundation

// Phone work: the owner's coding Sessions and Runs, as the Mac serves them to
// this phone. The list, Start work, the Run detail and the Terminal text come
// from /api/phone/* (src/server/phone-work.ts); following a conversation,
// answering, approving and steering a Run use the Mac's own routes, so both
// screens drive the same work. Nothing is kept on the phone after the app
// closes.

/** One coding Session on the Mac, started there or from this phone. */
struct WorkSession: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let agent: String
    let origin: String
    let repoId: String?
    let repoName: String
    let branch: String?
    let status: String
    let live: Bool
    let startedAt: String
    let lastActivityAt: String
    let endedAt: String?
    let need: String?

    var agentName: String { agent == "codex" ? "Codex" : "Claude" }
    var statusLabel: String {
        if let need { return Work.needLabel(need) }
        if !live { return "Ended" }
        switch status {
        case "starting": return "Starting"
        case "working": return "Working"
        case "waiting_input": return "Waiting on you"
        case "idle": return "Idle"
        case "completed": return "Done"
        default: return "Running"
        }
    }
    var tone: Work.Tone {
        if need != nil { return .waiting }
        if !live { return .ended }
        return status == "working" || status == "starting" ? .working : .idle
    }
}

struct RunAttention: Decodable, Equatable {
    let id: String
    let kind: String
    let reason: String
    let requestedAt: String
}

/** One Structured Run on the Mac. */
struct WorkRun: Decodable, Identifiable, Equatable {
    let id: String
    let objective: String
    let repoId: String
    let repoName: String
    let status: String
    let runtime: String?
    let submittedAt: String
    let updatedAt: String
    let attemptCount: Int
    let pendingAttention: RunAttention?
    let review: String

    var agentName: String { runtime == "codex" ? "Codex" : runtime == "claude" ? "Claude" : "Auto" }
    var settled: Bool { Work.settledRunStatuses.contains(status) }
    var statusLabel: String {
        if pendingAttention != nil { return "Needs your OK" }
        if review == "ready_to_review" { return "Ready to review" }
        return Work.runStatusLabel(status)
    }
    var tone: Work.Tone {
        if pendingAttention != nil { return .waiting }
        if review == "ready_to_review" { return .review }
        if status.hasPrefix("failed") { return .failed }
        if settled { return .ended }
        return .working
    }
}

/** Something on the Mac waiting on the owner. */
struct WorkNeed: Decodable, Identifiable, Equatable {
    let id: String
    let kind: String
    let sessionId: String?
    let runId: String?
    let title: String
    let detail: String?
    let at: String

    var label: String { Work.needLabel(kind) }
}

struct WorkFeed: Decodable, Equatable {
    let sessions: [WorkSession]
    let runs: [WorkRun]
    let needs: [WorkNeed]
}

struct WorkRepo: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let currentBranch: String?
    /** "required", "none" or "missing": the Repository's checks as set on the Mac. */
    let checks: String
    let checkNames: [String]?
}

struct AgentAvailability: Decodable, Equatable {
    let agent: String
    let quick: Bool
    let structured: Bool
}

struct RepoList: Decodable, Equatable {
    let repos: [WorkRepo]
    let agents: [AgentAvailability]
}

// MARK: - Conversation

struct ConversationTurn: Decodable, Identifiable, Equatable {
    let id: String
    let role: String
    /** Image turns: the file the agent opened, or empty. */
    let text: String
    let toolName: String?
    let ts: String
    let via: String?
    /** An image the agent looked at, fetched on its own when shown. */
    let image: TurnImage?
}

struct TurnImage: Decodable, Equatable { let id: String; let mediaType: String }

/** GET /api/sessions/:id/images/:imageId — base64 so it travels through the relay like any reply. */
struct ImagePayload: Decodable { let mediaType: String; let data: String }

struct QuestionOption: Decodable, Equatable { let label: String; let description: String? }

struct QuestionItem: Decodable, Equatable {
    let question: String
    let header: String?
    let multiSelect: Bool
    let options: [QuestionOption]
}

/** A multiple-choice question the agent has open. */
struct OpenQuestion: Decodable, Equatable {
    let id: String
    let delivery: String
    let questions: [QuestionItem]
    let canAnswer: Bool?
}

struct PlanStep: Decodable, Equatable { let label: String; let status: String }

struct Conversation: Decodable, Equatable {
    let found: Bool
    let turns: [ConversationTurn]
    let plan: [PlanStep]?
    let question: OpenQuestion?
}

struct InteractionChoice: Decodable, Equatable, Identifiable {
    let id: String
    let label: String
    let description: String?
    let questionId: String?
    let multiple: Bool?
}

/** An approval or question a Claude hook is holding for an answer. */
struct Interaction: Decodable, Equatable, Identifiable {
    let id: String
    let kind: String
    let question: String
    let choices: [InteractionChoice]
    let context: String?
    let allowsFreeText: Bool
    let requestedAt: String
    let status: String
    let canRespond: Bool
    let responderDisplayName: String?
    let unavailableReason: String?
}

struct Interactions: Decodable, Equatable {
    let processingState: String
    let interactions: [Interaction]
}

struct TerminalScreen: Decodable, Equatable {
    let seq: Int
    let text: String
    let live: Bool
    let available: Bool
}

// MARK: - Runs

struct RunTimelineItem: Decodable, Equatable, Identifiable {
    let at: String
    let label: String
    let detail: String?
    let tone: String
    var id: String { "\(at)|\(label)|\(detail ?? "")" }
}

struct RunCheck: Decodable, Equatable { let name: String; let passed: Bool }
struct RunCommit: Decodable, Equatable { let sha: String; let branch: String }

struct RunResultInfo: Decodable, Equatable {
    let outcome: String
    let summary: String?
    let changedFiles: [String]
    let commit: RunCommit?
    let applied: Bool
    let checks: [RunCheck]
    let notes: String?
}

struct RunPublicationInfo: Decodable, Equatable { let state: String; let target: String; let url: String? }

struct RunActions: Decodable, Equatable {
    let prepare: Bool
    let start: Bool
    let pause: Bool
    let resume: Bool
    let cancel: Bool
    let retry: Bool
    let apply: Bool
    let publish: Bool
    let review: Bool
}

struct RunDetail: Decodable, Equatable, Identifiable {
    let id: String
    let objective: String
    let repoId: String
    let repoName: String
    let status: String
    let runtime: String?
    let submittedAt: String
    let attemptCount: Int
    let pendingAttention: RunAttention?
    let review: String
    let acceptanceCriteria: [String]
    let baseReference: String
    let delivery: String
    let budgetMinutes: Int?
    let elapsedMinutes: Int?
    let worktreePath: String?
    let branch: String?
    let timeline: [RunTimelineItem]
    let result: RunResultInfo?
    let publication: RunPublicationInfo?
    let actions: RunActions
}

struct DiffFileSummary: Decodable, Equatable, Identifiable {
    let path: String
    let status: String
    let additions: Int
    let deletions: Int
    let binary: Bool?
    var id: String { path }
}

struct DiffSummary: Decodable, Equatable { let files: [DiffFileSummary] }
struct FileDiff: Decodable, Equatable { let diff: String; let truncated: Bool }

// MARK: - Requests

struct StartQuick: Encodable {
    let repositoryId: String
    let task: String
    let agent: String
    let permissionMode: String
    let branch: String?
    let createBranch: Bool
}

struct StartStructured: Encodable {
    let repositoryId: String
    let objective: String
    let acceptanceCriteria: [String]
    let agent: String
    let wallClockMinutes: Int
    let delivery: String
    let baseReference: String?
}

struct StartedSession: Decodable { let id: String }
struct StartedRun: Decodable { let id: String; let startError: String? }
struct SendText: Encodable { let text: String }
struct SendKeys: Encodable { let keys: [String] }
struct ApprovalDecision: Encodable { let decision: String }
struct InteractionAnswers: Encodable { let answers: [String: [String]] }

struct QuestionAnswer: Encodable, Equatable {
    var selected: [Int]
    var other: String?
}
struct AnswerQuestion: Encodable { let questionId: String; let answers: [QuestionAnswer] }
struct AttentionInput: Encodable { let value: String }
struct RunFeedback: Encodable { let text: String; let reviewDecision: String? }
struct PublishRun: Encodable { let target: String }

// MARK: - Labels

enum Work {
    enum Tone { case working, waiting, review, failed, ended, idle }

    static let settledRunStatuses: Set<String> = [
        "completed", "completed_unverified", "failed_verification", "failed_budget", "failed", "cancelled",
    ]

    /** The control keys the Mac accepts from a phone, by name (src/protocol.ts CONTROL_KEYS). */
    static let keys = ["Esc", "Ctrl-C", "↑", "↓", "←", "→", "Enter"]

    /** Why an image the agent looked at is not shown. */
    static func imageFailure(_ error: Error) -> String {
        switch error {
        case CompanionFailure.refused(let message): return message
        case CompanionFailure.unavailable: return "The Mac isn’t answering, so this image can’t load."
        default: return "This image could not be read."
        }
    }

    static func needLabel(_ kind: String) -> String {
        switch kind {
        case "session-approval": return "Approve"
        case "session-question": return "Answer a question"
        case "session-waiting": return "Waiting on you"
        case "run-attention": return "Needs your OK"
        case "run-review": return "Ready to review"
        default: return "Needs you"
        }
    }

    static func runStatusLabel(_ status: String) -> String {
        switch status {
        case "queued": return "Queued"
        case "preparing": return "Preparing"
        case "running": return "Working"
        case "waiting_approval": return "Needs your OK"
        case "waiting_input": return "Needs your input"
        case "waiting_dependency": return "Waiting"
        case "verifying": return "Checking"
        case "reviewing": return "Reviewing"
        case "completed": return "Done"
        case "completed_unverified": return "Done, not checked"
        case "failed_verification": return "Checks failed"
        case "failed_budget": return "Out of time"
        case "failed": return "Failed"
        case "pause_requested": return "Pausing"
        case "paused": return "Paused"
        case "cancelled": return "Cancelled"
        default: return status
        }
    }

    static func deliveryLabel(_ delivery: String) -> String {
        switch delivery {
        case "apply-to-repository": return "Apply to the repository"
        case "local-commit": return "Commit on its own branch"
        case "pull-request": return "Open a pull request"
        case "working-tree": return "Leave changes uncommitted"
        default: return delivery
        }
    }

    /** "2m", "3h", "4d" since an ISO time. */
    static func ago(_ iso: String, now: Date = Date()) -> String {
        guard let date = Format.date(iso) else { return "" }
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        if seconds < 60 { return "now" }
        if seconds < 3600 { return "\(seconds / 60)m" }
        if seconds < 86_400 { return "\(seconds / 3600)h" }
        return "\(seconds / 86_400)d"
    }

    /** A query value. Path segments are ids the Mac minted, which need no encoding. */
    static func query(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? value
    }
}
