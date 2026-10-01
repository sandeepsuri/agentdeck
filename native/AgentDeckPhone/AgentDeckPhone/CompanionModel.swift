import Foundation

// Issue #87: follows the owner's personal tasks on the Mac. Everything shown
// comes from the Mac's durable state: a reconnect reloads it, and while the
// Mac cannot be reached nothing is shown as live.

@MainActor final class CompanionModel: ObservableObject {
    enum Link: Equatable { case connecting, live, unavailable }
    enum Tab: Hashable { case ask, tasks, needsYou, window }

    @Published private(set) var link: Link = .connecting
    @Published private(set) var grants: [FolderGrant] = []
    @Published private(set) var tasks: [PersonalTask] = []
    @Published private(set) var lastReached: Date?
    @Published var tab: Tab = .needsYou
    @Published var tasksPath: [String] = []
    @Published var notice: String?

    var needs: [Need] { Need.from(tasks) }
    var activeGrants: [FolderGrant] { grants.filter { $0.revokedAt == nil } }

    private let client: CompanionClient
    private let onRevoked: () -> Void
    private var following: Task<Void, Never>?
    /**
     * One idempotency key per filing retry or undo the owner asked for, kept
     * until the Mac answers. A request lost to a dropped connection is sent
     * again with the same key, so the Mac performs it at most once.
     */
    private var pendingKeys: [String: String] = [:]

    init(client: CompanionClient, onRevoked: @escaping () -> Void) {
        self.client = client
        self.onRevoked = onRevoked
    }

    /** Issue #91: the Mac window the owner shared, streamed only while its tab is open. */
    private(set) lazy var window = WindowViewModel(client: client) { [weak self] error in self?.handle(error) }

    func task(_ id: String) -> PersonalTask? { tasks.first { $0.id == id } }

    /** Refreshes now, then keeps following: closely while anything is moving, and every few seconds while the Mac is away. */
    func follow() {
        following?.cancel()
        following = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refresh()
                let seconds: UInt64 = self.link != .live ? 5 : self.tasks.contains(where: \.unsettled) ? 2 : 10
                try? await Task.sleep(nanoseconds: seconds * 1_000_000_000)
            }
        }
    }

    /** Also ends any window view, so a phone in the background never keeps the Mac capturing. */
    func stop() { following?.cancel(); following = nil; window.stop() }

    func refresh() async {
        do {
            async let grants: [FolderGrant] = client.get("api/personal/grants")
            async let tasks: [PersonalTask] = client.get("api/personal/tasks")
            (self.grants, self.tasks) = try await (grants, tasks)
            link = .live
            lastReached = Date()
        } catch {
            handle(error)
        }
    }

    func pdfs(in grant: FolderGrant) async throws -> PdfListing {
        do { return try await client.get("api/personal/grants/\(grant.id)/pdfs") }
        catch { handle(error); throw error }
    }

    /** Submits an inventory or a filing proposal and opens it in Tasks. */
    func ask(kind: TaskKind, grant: FolderGrant, files: [String]) async -> Bool {
        await perform {
            let task: PersonalTask = try await self.client.post("api/personal/tasks", SubmitTask(kind: kind, grantId: grant.id, files: files))
            self.upsert(task)
            self.tab = .tasks
            self.tasksPath = [task.id]
        }
    }

    /** Approves exactly the plan shown, by its fingerprint; the Mac refuses one that changed. */
    func approve(_ task: PersonalTask, replacing: Set<String>) async -> Bool {
        guard let digest = task.result?.planDigest else { return false }
        let overwrite = (task.result?.entries ?? []).map(\.source).filter(replacing.contains)
        return await perform {
            let updated: PersonalTask = try await self.client.post("api/personal/tasks/\(task.id)/filing/approve", ApproveFiling(planDigest: digest, overwrite: overwrite))
            self.upsert(updated)
        }
    }

    func retryTask(_ task: PersonalTask) async -> Bool {
        await perform {
            let updated: PersonalTask = try await self.client.post("api/personal/tasks/\(task.id)/retry", Empty())
            self.upsert(updated)
        }
    }

    func filing(_ action: FilingFollowUp, _ task: PersonalTask) async -> Bool {
        let slot = "\(task.id)/\(action.rawValue)"
        let key = pendingKeys[slot] ?? UUID().uuidString
        pendingKeys[slot] = key
        return await perform {
            let updated: PersonalTask = try await self.client.post("api/personal/tasks/\(task.id)/filing/\(action.rawValue)", FilingAction(idempotencyKey: key))
            self.pendingKeys[slot] = nil
            self.upsert(updated)
        }
    }

    private func perform(_ action: @escaping () async throws -> Void) async -> Bool {
        notice = nil
        do { try await action(); return true }
        catch { handle(error); return false }
    }

    private func upsert(_ task: PersonalTask) {
        if let index = tasks.firstIndex(where: { $0.id == task.id }) { tasks[index] = task }
        else { tasks.insert(task, at: 0) }
    }

    private func handle(_ error: Error) {
        switch error as? CompanionFailure {
        case .revoked:
            stop()
            onRevoked()
        case .refused(let message):
            notice = message
        case .unavailable, nil:
            // Never keep showing the last answer as if it were current. Where
            // the owner was (tasksPath) is kept, so reconnecting reopens it.
            link = .unavailable
            grants = []
            tasks = []
        }
    }
}

/**
 * Issue #91: views the one window the owner shared on the Mac. The Mac
 * captures only while this phone keeps asking for frames, so leaving the tab,
 * backgrounding the app, or losing the Mac ends the capture there too. No
 * frame outlives the view.
 */
@MainActor final class WindowViewModel: ObservableObject {
    enum State: Equatable { case idle, starting, viewing }

    @Published private(set) var status: WindowViewStatus?
    @Published private(set) var state: State = .idle
    /** The latest frame's JPEG, only while viewing. */
    @Published private(set) var jpeg: Data?
    @Published private(set) var frameAt: String?
    /** Why the last view ended, in the Mac's words. */
    @Published private(set) var ended: String?

    private let client: CompanionClient
    private let onFailure: (Error) -> Void
    private var viewId: String?
    private var streaming: Task<Void, Never>?

    init(client: CompanionClient, onFailure: @escaping (Error) -> Void) {
        self.client = client
        self.onFailure = onFailure
    }

    func load() async {
        do { status = try await client.get("api/window-view/phone") }
        catch { report(error) }
    }

    func start() {
        guard streaming == nil else { return }
        ended = nil
        state = .starting
        streaming = Task { [weak self] in await self?.stream() }
    }

    /** Ends the view here at once and tells the Mac, which stops capturing. */
    func stop() {
        guard let streaming else { return }
        streaming.cancel()
        self.streaming = nil
        let id = viewId
        clear()
        guard let id else { return }
        let client = client
        Task { let _: WindowViewStatus? = try? await client.post("api/window-view/stop", StopView(viewId: id)) }
    }

    private func stream() async {
        do {
            // Not cancelled with the view: a start the Mac carried out must be answered, so it can be stopped below.
            let client = client
            let started: StartedView = try await Task { try await client.post("api/window-view/start", Empty()) }.value
            // Left before the Mac answered: end the capture it just started.
            guard !Task.isCancelled else {
                Task { let _: WindowViewStatus? = try? await client.post("api/window-view/stop", StopView(viewId: started.viewId)) }
                return
            }
            viewId = started.viewId
            state = .viewing
            var after = 0
            while !Task.isCancelled {
                let answer: FrameAnswer = try await client.get("api/window-view/frame?view=\(started.viewId)&after=\(after)&wait=1500")
                try Task.checkCancellation()
                if let frame = answer.frame, let data = Data(base64Encoded: frame.jpeg) {
                    after = frame.seq
                    jpeg = data
                    frameAt = frame.capturedAt
                }
            }
        } catch {
            // stop() already cleared everything for a view the phone ended itself.
            guard !Task.isCancelled else { return }
            streaming = nil
            clear()
            report(error)
            await load()
        }
    }

    private func clear() {
        viewId = nil
        jpeg = nil
        frameAt = nil
        state = .idle
    }

    private func report(_ error: Error) {
        if case CompanionFailure.refused(let message) = error { ended = message }
        else { onFailure(error) }
    }
}
