import Foundation

// Phone work: follows the owner's coding Sessions and Runs on the Mac and
// sends what the owner decides. The Work list is refreshed with the rest of
// the companion (CompanionModel.refresh); an open Session or Run is followed
// more closely by its own follower, only while its screen is open. Every
// action goes to the Mac, which does the work and records it against this
// phone; the phone shows the Mac's answer, never a guess.

enum WorkRoute: Hashable {
    case session(String)
    case run(String)
}

@MainActor final class WorkModel: ObservableObject {
    @Published private(set) var feed: WorkFeed?
    @Published var path: [WorkRoute] = []
    @Published var notice: String?

    let client: CompanionClient
    private let onFailure: (Error) -> Void
    /** Images already fetched this launch; a transcript image never changes. Kept in memory only. */
    private var images: [String: Data] = [:]

    init(client: CompanionClient, onFailure: @escaping (Error) -> Void) {
        self.client = client
        self.onFailure = onFailure
    }

    var sessions: [WorkSession] { feed?.sessions ?? [] }
    var runs: [WorkRun] { feed?.runs ?? [] }
    var needs: [WorkNeed] { feed?.needs ?? [] }
    /** Something is moving, so the list is worth following closely. */
    var busy: Bool { sessions.contains { $0.live && $0.tone == .working } || runs.contains { !$0.settled } }

    func session(_ id: String) -> WorkSession? { sessions.first { $0.id == id } }
    func run(_ id: String) -> WorkRun? { runs.first { $0.id == id } }

    /** Set by CompanionModel.refresh; nil when the Mac has no phone work (an older AgentDeck). */
    func apply(_ feed: WorkFeed?) { self.feed = feed }
    func clear() { feed = nil }

    func refresh() async {
        do { feed = try await client.get("api/phone/work") }
        catch { report(error) }
    }

    func repos() async -> RepoList? {
        do { return try await client.get("api/phone/repos") }
        catch { report(error); return nil }
    }

    /** Starts a Quick session and opens it. */
    func startQuick(_ request: StartQuick) async -> Bool {
        await perform {
            let started: StartedSession = try await self.client.post("api/phone/sessions", request)
            await self.refresh()
            self.path = [.session(started.id)]
        }
    }

    /** Submits, prepares and starts a Run, then opens it; a start that failed shows there with Try again. */
    func startStructured(_ request: StartStructured) async -> Bool {
        await perform {
            let started: StartedRun = try await self.client.post("api/phone/runs", request)
            await self.refresh()
            self.path = [.run(started.id)]
            if let error = started.startError { self.notice = "Submitted, but it didn’t start: \(error)" }
        }
    }

    // MARK: Sessions

    func send(_ text: String, to sessionId: String) async -> Bool {
        await perform { let _: Ignored = try await self.client.post("api/sessions/\(sessionId)/send", SendText(text: text)) }
    }

    func keys(_ keys: [String], to sessionId: String) async -> Bool {
        await perform { let _: Ignored = try await self.client.post("api/phone/sessions/\(sessionId)/keys", SendKeys(keys: keys)) }
    }

    func stopSession(_ sessionId: String) async -> Bool {
        await perform {
            let _: Ignored = try await self.client.post("api/sessions/\(sessionId)/stop", Empty())
            await self.refresh()
        }
    }

    func decide(_ interaction: Interaction, approve: Bool, in sessionId: String) async -> Bool {
        await perform {
            let _: Ignored = try await self.client.post("api/sessions/\(sessionId)/interactions/\(interaction.id)/respond",
                                                         ApprovalDecision(decision: approve ? "approve" : "deny"))
        }
    }

    func answer(_ interaction: Interaction, with answers: [String: [String]], in sessionId: String) async -> Bool {
        await perform {
            let _: Ignored = try await self.client.post("api/sessions/\(sessionId)/interactions/\(interaction.id)/respond",
                                                         InteractionAnswers(answers: answers))
        }
    }

    func answer(_ question: OpenQuestion, with answers: [QuestionAnswer], in sessionId: String) async -> Bool {
        await perform {
            let _: Ignored = try await self.client.post("api/sessions/\(sessionId)/conversation/answer",
                                                         AnswerQuestion(questionId: question.id, answers: answers))
        }
    }

    // MARK: Runs

    /** prepare, start, attempts (try again), pause, resume, cancel, apply. */
    func runAction(_ verb: String, _ runId: String) async -> Bool {
        await perform {
            let _: Ignored = try await self.client.post("api/runs/\(runId)/\(verb)", Empty())
            await self.refresh()
        }
    }

    func attention(_ runId: String, _ attention: RunAttention, approve: Bool) async -> Bool {
        await perform {
            let _: Ignored = try await self.client.post("api/runs/\(runId)/attention/\(attention.id)/\(approve ? "approve" : "deny")", Empty())
        }
    }

    func attention(_ runId: String, _ attention: RunAttention, input: String) async -> Bool {
        await perform {
            let _: Ignored = try await self.client.post("api/runs/\(runId)/attention/\(attention.id)/input", AttentionInput(value: input))
        }
    }

    func feedback(_ runId: String, text: String, decision: String?) async -> Bool {
        await perform {
            let _: Ignored = try await self.client.post("api/runs/\(runId)/feedback", RunFeedback(text: text, reviewDecision: decision))
            await self.refresh()
        }
    }

    func publish(_ runId: String, target: String) async -> Bool {
        await perform { let _: Ignored = try await self.client.post("api/runs/\(runId)/publish", PublishRun(target: target)) }
    }

    // MARK: Plumbing

    /** An image the agent looked at. Throws the Mac's reason when it cannot be sent. */
    func image(_ imageId: String, in sessionId: String) async throws -> Data {
        let key = "\(sessionId)/\(imageId)"
        if let cached = images[key] { return cached }
        let payload: ImagePayload = try await client.get("api/sessions/\(sessionId)/images/\(imageId)")
        guard let data = Data(base64Encoded: payload.data) else { throw ImageUnreadable() }
        if images.count >= 40 { images.removeAll() }
        images[key] = data
        return data
    }

    func perform(_ action: @escaping () async throws -> Void) async -> Bool {
        notice = nil
        do { try await action(); return true }
        catch { report(error); return false }
    }

    /** The Mac's refusal is shown here; losing the Mac or this phone's pairing is the companion's to handle. */
    func report(_ error: Error) {
        if case CompanionFailure.refused(let message) = error { notice = message }
        else { onFailure(error) }
    }
}

/** Any JSON answer whose body the phone does not need. */
struct Ignored: Decodable {}

struct ImageUnreadable: LocalizedError {
    var errorDescription: String? { "This image could not be read." }
}

/**
 * Follows one Session while its screen is open: the conversation and any
 * held approval or question every 1.5 seconds, and the Terminal's text by
 * long-poll while that toggle is on. Leaving the screen stops both, and the
 * Mac stops rendering the terminal shortly after.
 */
@MainActor final class SessionFollower: ObservableObject {
    @Published private(set) var conversation: Conversation?
    @Published private(set) var interactions: [Interaction] = []
    @Published private(set) var screen: TerminalScreen?

    let sessionId: String
    private let work: WorkModel
    private var following: Task<Void, Never>?
    private var watching: Task<Void, Never>?

    init(sessionId: String, work: WorkModel) {
        self.sessionId = sessionId
        self.work = work
    }

    var pending: [Interaction] { interactions.filter { $0.status == "pending" } }

    func follow() {
        following?.cancel()
        following = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refresh()
                try? await Task.sleep(nanoseconds: 1_500_000_000)
            }
        }
    }

    func refresh() async {
        let client = work.client
        do {
            async let conversation: Conversation = client.get("api/sessions/\(sessionId)/conversation")
            async let interactions: Interactions = client.get("api/sessions/\(sessionId)/interactions")
            let (nextConversation, nextInteractions) = try await (conversation, interactions)
            self.conversation = nextConversation
            self.interactions = nextInteractions.interactions
        } catch {
            work.report(error)
        }
    }

    func watchTerminal() {
        guard watching == nil else { return }
        let client = work.client
        let sessionId = sessionId
        watching = Task { [weak self] in
            var after = -1
            while !Task.isCancelled {
                do {
                    let next: TerminalScreen = try await client.get("api/phone/sessions/\(sessionId)/screen?after=\(after)&wait=1500")
                    try Task.checkCancellation()
                    self?.screen = next
                    after = next.seq
                    // An ended session's text does not change.
                    if !next.live { return }
                } catch {
                    guard !Task.isCancelled else { return }
                    self?.work.report(error)
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                }
            }
        }
    }

    func stopTerminal() { watching?.cancel(); watching = nil }

    func stop() {
        following?.cancel(); following = nil
        stopTerminal()
    }
}

/** Follows one Run's detail every two seconds while its screen is open. */
@MainActor final class RunFollower: ObservableObject {
    @Published private(set) var detail: RunDetail?
    @Published private(set) var missing = false

    let runId: String
    private let work: WorkModel
    private var following: Task<Void, Never>?

    init(runId: String, work: WorkModel) {
        self.runId = runId
        self.work = work
    }

    func follow() {
        following?.cancel()
        following = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refresh()
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    func refresh() async {
        do {
            detail = try await work.client.get("api/phone/runs/\(runId)")
            missing = false
        } catch CompanionFailure.refused {
            missing = true
        } catch {
            work.report(error)
        }
    }

    func diff() async -> DiffSummary? {
        guard let worktree = detail?.worktreePath else { return nil }
        do { return try await work.client.get("api/repos/diff?repo=\(Work.query(worktree))&mode=branch") }
        catch { work.report(error); return nil }
    }

    func fileDiff(_ file: String) async -> FileDiff? {
        guard let worktree = detail?.worktreePath else { return nil }
        do { return try await work.client.get("api/repos/diff/file?repo=\(Work.query(worktree))&mode=branch&path=\(Work.query(file))") }
        catch { work.report(error); return nil }
    }

    func stop() { following?.cancel(); following = nil }
}
