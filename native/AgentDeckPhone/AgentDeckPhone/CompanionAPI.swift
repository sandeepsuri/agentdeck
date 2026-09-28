import Foundation

// Issue #87: the owner's personal tasks and filing decisions, as the Mac
// serves them under /api/personal/*. These mirror the server's browser
// projections (src/personal-tasks/types.ts); nothing here is kept on the
// phone after the app closes, so a reconnect always shows the Mac's state.

struct FolderGrant: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let displayPath: String
    let revokedAt: String?
}

struct PdfListing: Decodable, Equatable {
    struct File: Decodable, Equatable, Identifiable {
        let relativePath: String
        let size: Int
        var id: String { relativePath }
    }
    let files: [File]
    let truncated: Bool
}

enum TaskStatus: String, Decodable { case queued, running, completed, failed }

struct PlanWarning: Decodable, Equatable {
    let kind: String
    let message: String
}

struct PlanEntry: Decodable, Equatable, Identifiable {
    let source: String
    let newName: String
    let destination: String
    let target: String
    let warnings: [PlanWarning]
    var id: String { source }
    /** Something already sits at the target; it moves only if the owner chooses to replace it. */
    var replacesFile: Bool { warnings.contains { $0.kind == "overwrite" || $0.kind == "already-filed" } }
    var unchanged: Bool { warnings.contains { $0.kind == "unchanged" } }
}

struct PathReason: Decodable, Equatable, Identifiable {
    let path: String
    let reason: String
    var id: String { path }
}

struct InventoryFile: Decodable, Equatable, Identifiable {
    let path: String
    let size: Int
    let pageCount: Int?
    let encrypted: Bool
    var id: String { path }
}

/** An inventory or a filing proposal; the server tells them apart by `kind`. */
struct TaskResult: Decodable, Equatable {
    let kind: String?
    let planDigest: String?
    let entries: [PlanEntry]?
    let unplanned: [PathReason]?
    let files: [InventoryFile]?
    let totalBytes: Int?
    let knownPages: Int?
    let skipped: [PathReason]
    var isProposal: Bool { kind == TaskKind.filingProposal.rawValue }
}

struct Receipt: Decodable, Equatable, Identifiable {
    let sequence: Int
    let source: String
    let target: String
    let state: String
    let reason: String?
    let undoState: String?
    var id: Int { sequence }

    var label: String {
        if undoState == "undone" { return "Restored" }
        switch state {
        case "pending": return "Waiting"
        case "moving": return "Moving"
        case "moved": return "Moved"
        case "skipped": return "Left in place"
        case "failed": return "Not moved"
        default: return "Check folder"
        }
    }
}

struct Filing: Decodable, Equatable {
    let state: String
    let planDigest: String
    let approvedBy: Attribution
    let approvedAt: String
    let receipts: [Receipt]
    var settled: Bool { state == "finished" || state == "expired" }
}

struct Attribution: Decodable, Equatable {
    let displayName: String
    let device: String
}

struct Activity: Decodable, Equatable, Identifiable {
    let sequence: Int
    let at: String
    let kind: String
    let message: String
    var id: Int { sequence }
}

struct PersonalTask: Decodable, Equatable, Identifiable {
    struct Grant: Decodable, Equatable { let id: String; let name: String; let revoked: Bool }
    let id: String
    let kind: String
    let title: String
    let status: TaskStatus
    let grant: Grant
    let files: [String]
    let submittedAt: String
    let updatedAt: String
    let submittedBy: Attribution
    let activity: [Activity]
    let failure: String?
    let result: TaskResult?
    let filing: Filing?

    /** Still changing on the Mac, so worth following closely. */
    var unsettled: Bool {
        status == .queued || status == .running || (filing.map { !$0.settled } ?? false)
    }
    var statusLabel: String {
        if let filing, !filing.settled { return "Moving files" }
        switch status {
        case .queued: return "Queued"
        case .running: return "Working"
        case .completed: return result?.isProposal == true && filing == nil ? "Ready to review" : "Done"
        case .failed: return "Needs attention"
        }
    }
}

/** One item in the phone's Needs you list: a plan to decide or a task that went wrong. */
struct Need: Identifiable, Equatable {
    enum Kind: Int { case decision = 0, problem = 1 }
    let kind: Kind
    let taskId: String
    let title: String
    let reason: String
    let since: String
    var id: String { taskId }

    /** Decisions first, then problems; the oldest of each first. */
    static func from(_ tasks: [PersonalTask]) -> [Need] {
        tasks.compactMap { task -> Need? in
            if task.status == .failed {
                return Need(kind: .problem, taskId: task.id, title: task.title, reason: task.failure ?? "The task failed.", since: task.updatedAt)
            }
            guard task.status == .completed, let result = task.result, result.isProposal else { return nil }
            guard let filing = task.filing else {
                let count = result.entries?.count ?? 0
                return Need(kind: .decision, taskId: task.id, title: task.title,
                            reason: "Review the plan to file \(Format.pdfs(count)). Nothing moves until you approve.", since: task.updatedAt)
            }
            if filing.state == "expired" {
                return Need(kind: .problem, taskId: task.id, title: task.title, reason: "The approval expired before anything moved.", since: task.updatedAt)
            }
            let unsure = filing.receipts.filter { $0.state == "failed" || $0.state == "uncertain" }.count
            guard filing.state == "finished", unsure > 0 else { return nil }
            return Need(kind: .problem, taskId: task.id, title: task.title,
                        reason: "\(unsure) PDF\(unsure == 1 ? " was" : "s were") not moved or need checking.", since: task.updatedAt)
        }
        .sorted { ($0.kind.rawValue, $0.since) < ($1.kind.rawValue, $1.since) }
    }
}

enum CompanionFailure: Error, Equatable {
    /** The Mac, its service, or the network path to it is not answering. An error the Mac answered with is a refusal, not this. */
    case unavailable
    /** This phone's credential no longer resolves: it was revoked on the Mac. */
    case revoked
    /** The Mac answered and refused; the message is the server's own. */
    case refused(String)
}

struct CompanionClient {
    let base: URL
    let credential: String
    var session: URLSession = .shared

    private struct ServerError: Decodable { let error: String? }
    private struct Connection: Decodable { let kind: String; let capabilities: [String] }

    func get<T: Decodable>(_ path: String) async throws -> T {
        try await send(path, method: "GET", body: nil)
    }

    func post<T: Decodable, Body: Encodable>(_ path: String, _ body: Body) async throws -> T {
        try await send(path, method: "POST", body: try JSONEncoder().encode(body))
    }

    /** Whether the Mac still accepts this phone; throws `.unavailable` when it cannot say. */
    func stillPaired() async throws -> Bool {
        let connection: Connection = try await send("api/connection", method: "GET", body: nil, checkRevoked: false)
        return connection.kind == "remote" && !connection.capabilities.isEmpty
    }

    private func send<T: Decodable>(_ path: String, method: String, body: Data?, checkRevoked: Bool = true) async throws -> T {
        var request = URLRequest(url: base.appending(path: path))
        request.httpMethod = method
        request.timeoutInterval = 10
        request.setValue(credential, forHTTPHeaderField: "x-agentdeck-token")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = body
        }
        let data: Data
        let response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch { throw CompanionFailure.unavailable }
        guard let http = response as? HTTPURLResponse else { throw CompanionFailure.unavailable }
        if (200..<300).contains(http.statusCode) {
            do { return try JSONDecoder().decode(T.self, from: data) }
            catch { throw CompanionFailure.refused("The Mac sent an answer this app does not understand. Update AgentDeck Phone.") }
        }
        if http.statusCode == 403, checkRevoked {
            let paired = try await stillPaired()
            if !paired { throw CompanionFailure.revoked }
        }
        let message = (try? JSONDecoder().decode(ServerError.self, from: data))?.error
        throw CompanionFailure.refused(message ?? "AgentDeck refused the request.")
    }
}

/** What Ask can request, by the server's task kind. */
enum TaskKind: String, Encodable { case inventory = "pdf-inventory", filingProposal = "pdf-filing-proposal" }

/** Follow-ups on a finished filing, by the route's action name. */
enum FilingFollowUp: String { case retry, undo }

// Request bodies, typed so the phone can only ask for what the routes accept.
struct SubmitTask: Encodable { let kind: TaskKind; let grantId: String; let files: [String] }
struct ApproveFiling: Encodable { let planDigest: String; let overwrite: [String] }
struct FilingAction: Encodable { let idempotencyKey: String }
struct Empty: Codable {}

enum Format {
    private static let parser: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let wholeSeconds = ISO8601DateFormatter()

    static func date(_ iso: String) -> Date? { parser.date(from: iso) ?? wholeSeconds.date(from: iso) }

    /** "1 PDF", "3 PDFs". */
    static func pdfs(_ count: Int) -> String { "\(count) PDF\(count == 1 ? "" : "s")" }

    static func time(_ iso: String) -> String {
        guard let date = date(iso) else { return iso }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    static func bytes(_ count: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(count), countStyle: .file)
    }
}
