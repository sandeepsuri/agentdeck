import SwiftUI

// Phone work: start, follow and steer the owner's coding Sessions and Runs.
// The same work the Mac shows, driven from either screen. System fonts,
// colors and list styles carry Dynamic Type, VoiceOver and light and dark
// appearance; status is always written out, never shown by color alone.

// MARK: - Work list

struct WorkListView: View {
    @ObservedObject var work: WorkModel
    @State private var starting = false

    var body: some View {
        NavigationStack(path: $work.path) {
            List {
                WorkNoticeRow(work: work)
                if work.feed == nil {
                    Text("This Mac’s AgentDeck doesn’t offer coding work to the phone yet. Update AgentDeck on the Mac.")
                        .foregroundStyle(.secondary)
                } else if work.sessions.isEmpty && work.runs.isEmpty {
                    Text("Nothing running. Start work here or on the Mac; it shows up on both.")
                        .foregroundStyle(.secondary)
                } else {
                    let waitingSessions = work.sessions.filter { $0.need != nil }
                    let waitingRuns = work.runs.filter { $0.tone == .waiting || $0.tone == .review }
                    if !waitingSessions.isEmpty || !waitingRuns.isEmpty {
                        Section("Needs you") {
                            ForEach(waitingSessions) { SessionLink(session: $0) }
                            ForEach(waitingRuns) { RunLink(run: $0) }
                        }
                    }
                    let runningSessions = work.sessions.filter { $0.need == nil && $0.live }
                    let runningRuns = work.runs.filter { !$0.settled && $0.tone != .waiting && $0.tone != .review }
                    if !runningSessions.isEmpty || !runningRuns.isEmpty {
                        Section("Running") {
                            ForEach(runningSessions) { SessionLink(session: $0) }
                            ForEach(runningRuns) { RunLink(run: $0) }
                        }
                    }
                    let recentSessions = work.sessions.filter { $0.need == nil && !$0.live }
                    let recentRuns = work.runs.filter { $0.settled && $0.tone != .review }
                    if !recentSessions.isEmpty || !recentRuns.isEmpty {
                        Section("Recent") {
                            ForEach(recentSessions) { SessionLink(session: $0) }
                            ForEach(recentRuns) { RunLink(run: $0) }
                        }
                    }
                }
            }
            .navigationTitle("Work")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { starting = true } label: { Label("Start work", systemImage: "plus") }
                        .disabled(work.feed == nil)
                }
            }
            .navigationDestination(for: WorkRoute.self) { WorkDestination(work: work, route: $0) }
            .refreshable { await work.refresh() }
            .sheet(isPresented: $starting) { StartWorkSheet(work: work) }
        }
    }
}

struct WorkDestination: View {
    @ObservedObject var work: WorkModel
    let route: WorkRoute

    var body: some View {
        switch route {
        case .session(let id): SessionScreen(work: work, sessionId: id)
        case .run(let id): RunScreen(work: work, runId: id)
        }
    }
}

private struct SessionLink: View {
    let session: WorkSession

    var body: some View {
        NavigationLink(value: WorkRoute.session(session.id)) {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(session.name).font(.headline).lineLimit(2)
                    Spacer()
                    StatusChip(label: session.statusLabel, tone: session.tone)
                }
                Text([session.repoName, session.agentName, "Quick", session.origin == "external" ? "in a terminal on the Mac" : nil, Work.ago(session.lastActivityAt)]
                    .compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
            }
            .padding(.vertical, 2)
            .accessibilityElement(children: .combine)
        }
    }
}

private struct RunLink: View {
    let run: WorkRun

    var body: some View {
        NavigationLink(value: WorkRoute.run(run.id)) {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(run.objective).font(.headline).lineLimit(2)
                    Spacer()
                    StatusChip(label: run.statusLabel, tone: run.tone)
                }
                if let attention = run.pendingAttention {
                    Text(attention.reason).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                }
                Text("\(run.repoName) · \(run.agentName) · Run · \(Work.ago(run.updatedAt))")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .padding(.vertical, 2)
            .accessibilityElement(children: .combine)
        }
    }
}

struct WorkNeedRow: View {
    let need: WorkNeed

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("\(need.label) · \(need.sessionId != nil ? "Session" : "Run")")
                .font(.caption.weight(.semibold)).foregroundStyle(Color.orange)
            Text(need.title).font(.headline)
            if let detail = need.detail { Text(detail).font(.subheadline).foregroundStyle(.secondary).lineLimit(3) }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

struct StatusChip: View {
    let label: String
    let tone: Work.Tone

    private var color: Color {
        switch tone {
        case .working: return .green
        case .waiting: return .orange
        case .review: return .purple
        case .failed: return .red
        case .ended, .idle: return .secondary
        }
    }

    var body: some View {
        Text(label)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 7).padding(.vertical, 2)
            .foregroundStyle(color)
            .background(color.opacity(0.12), in: Capsule())
    }
}

/** The Mac's reason for refusing the last work request, until the next one. */
struct WorkNoticeRow: View {
    @ObservedObject var work: WorkModel

    var body: some View {
        if let notice = work.notice {
            Label(notice, systemImage: "exclamationmark.circle")
                .foregroundStyle(.red)
                .accessibilityLabel("AgentDeck says: \(notice)")
        }
    }
}

// MARK: - Start work

struct StartWorkSheet: View {
    @ObservedObject var work: WorkModel
    var repositoryId: String?
    @Environment(\.dismiss) private var dismiss

    enum Mode: String, CaseIterable { case quick = "Quick", structured = "Structured" }

    @State private var list: RepoList?
    @State private var loading = true
    @State private var task = ""
    @State private var repoId: String?
    @State private var agent = "auto"
    @State private var mode: Mode = .quick
    @State private var permissionMode = "default"
    @State private var branch = ""
    @State private var createBranch = false
    @State private var doneWhen = ""
    @State private var baseReference = ""
    @State private var minutes = 60
    @State private var delivery = "apply-to-repository"
    @State private var busy = false

    private var repo: WorkRepo? { list?.repos.first { $0.id == repoId } }
    private var criteria: [String] { doneWhen.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
    private var canStart: Bool {
        guard !busy, repo != nil, !task.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        return mode == .quick || (!criteria.isEmpty && repo?.checks != "missing")
    }

    var body: some View {
        NavigationStack {
            Form {
                WorkNoticeRow(work: work)
                if loading {
                    ProgressView("Asking your Mac for its repositories…")
                } else if let list, list.repos.isEmpty {
                    Text("No repositories yet. On the Mac, add a folder under Settings › Folder access; its repositories appear here.")
                } else if let list {
                    Section {
                        TextField(mode == .quick ? "What should the agent do?" : "Objective", text: $task, axis: .vertical)
                            .lineLimit(3...8)
                        Picker("Repository", selection: $repoId) {
                            ForEach(list.repos) { Text($0.name).tag(Optional($0.id)) }
                        }
                        Picker("Agent", selection: $agent) {
                            Text("Auto").tag("auto")
                            ForEach(list.agents, id: \.agent) { item in
                                Text(item.agent == "codex" ? "Codex" : "Claude").tag(item.agent)
                            }
                        }
                        .pickerStyle(.segmented)
                        Picker("Mode", selection: $mode) {
                            ForEach(Mode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                        }
                        .pickerStyle(.segmented)
                    } footer: {
                        Text(mode == .quick
                             ? "Quick runs the agent live in this repository on the Mac. You can continue on the Mac at any time."
                             : "Structured runs in its own worktree, checks its work and waits for your review.")
                    }
                    if mode == .quick { quickSection } else { structuredSection }
                }
            }
            .navigationTitle("Start work")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "Starting…" : mode == .quick ? "Start" : "Submit") { start() }.disabled(!canStart)
                }
            }
            .task { await load() }
            .onChange(of: repoId) { _ in baseReference = repo?.currentBranch ?? "" }
        }
    }

    @ViewBuilder private var quickSection: some View {
        Section {
            Picker("Permissions", selection: $permissionMode) {
                Text("Ask before edits").tag("default")
                Text("Accept edits").tag("acceptEdits")
                Text("Plan first").tag("plan")
            }
            TextField("Branch (optional, current if empty)", text: $branch)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            if !branch.trimmingCharacters(in: .whitespaces).isEmpty {
                Toggle("Create it if missing", isOn: $createBranch)
            }
        } footer: {
            if let current = repo?.currentBranch { Text("Now on \(current).") }
        }
    }

    @ViewBuilder private var structuredSection: some View {
        Section {
            TextField("One per line, e.g. tests cover the new export", text: $doneWhen, axis: .vertical)
                .lineLimit(2...6)
        } header: { Text("Done when") }
        Section {
            TextField("Start from", text: $baseReference)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            Stepper("Time limit: \(minutes) min", value: $minutes, in: 5...480, step: 5)
            Picker("When done", selection: $delivery) {
                ForEach(["apply-to-repository", "local-commit", "pull-request", "working-tree"], id: \.self) {
                    Text(Work.deliveryLabel($0)).tag($0)
                }
            }
        } footer: {
            switch repo?.checks {
            case "required": Text("Checks set on the Mac: \((repo?.checkNames ?? []).joined(separator: ", ")).")
            case "none": Text("This repository runs without checks, as set on the Mac.")
            case "missing": Text("Set this repository’s checks on the Mac first, in Start work › Structured.").foregroundStyle(.red)
            default: EmptyView()
            }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        guard let next = await work.repos() else { return }
        list = next
        repoId = repositoryId.flatMap { id in next.repos.first { $0.id == id }?.id } ?? repoId ?? next.repos.first?.id
        baseReference = repo?.currentBranch ?? ""
    }

    private func start() {
        guard let repo else { return }
        busy = true
        let trimmed = task.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            let started: Bool
            if mode == .quick {
                let name = branch.trimmingCharacters(in: .whitespaces)
                started = await work.startQuick(StartQuick(
                    repositoryId: repo.id, task: trimmed, agent: agent, permissionMode: permissionMode,
                    branch: name.isEmpty ? nil : name, createBranch: createBranch))
            } else {
                let base = baseReference.trimmingCharacters(in: .whitespaces)
                started = await work.startStructured(StartStructured(
                    repositoryId: repo.id, objective: trimmed, acceptanceCriteria: criteria, agent: agent,
                    wallClockMinutes: minutes, delivery: delivery, baseReference: base.isEmpty ? nil : base))
            }
            busy = false
            if started { dismiss() }
        }
    }
}

// MARK: - A live session

private struct SessionScreen: View {
    @ObservedObject var work: WorkModel
    let sessionId: String
    @StateObject private var follower: SessionFollower
    @State private var showTerminal = false
    @State private var confirmingStop = false
    @State private var followUp = false

    init(work: WorkModel, sessionId: String) {
        self.work = work
        self.sessionId = sessionId
        _follower = StateObject(wrappedValue: SessionFollower(sessionId: sessionId, work: work))
    }

    private var session: WorkSession? { work.session(sessionId) }
    private var live: Bool { session?.live ?? false }
    private var managed: Bool { session?.origin != "external" }

    var body: some View {
        VStack(spacing: 0) {
            Picker("View", selection: $showTerminal) {
                Text("Conversation").tag(false)
                Text("Terminal").tag(true)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal).padding(.bottom, 8)
            if let session, !session.live {
                Label("This session ended on the Mac\(session.endedAt.map { " at \(Format.time($0))" } ?? "").", systemImage: "stop.circle")
                    .font(.footnote).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal).padding(.bottom, 6)
            }
            if let notice = work.notice {
                Label(notice, systemImage: "exclamationmark.circle").font(.footnote).foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal).padding(.bottom, 6)
            }
            if showTerminal {
                TerminalPane(follower: follower, work: work, sessionId: sessionId, live: live && managed, available: managed)
            } else {
                ConversationPane(follower: follower, work: work, session: session)
            }
            if live {
                Composer(work: work, sessionId: sessionId, agent: session?.agent ?? "claude", placeholder: showTerminal ? "Type into the terminal…" : "Message \(session?.agentName ?? "the agent")…")
            } else if let session, let repoId = session.repoId {
                Button { followUp = true } label: {
                    Text("Start follow-up work in \(session.repoName)").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .padding()
                .sheet(isPresented: $followUp) { StartWorkSheet(work: work, repositoryId: repoId) }
            }
        }
        .navigationTitle(session?.name ?? "Session")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if live && managed {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button("Interrupt (Esc)") { Task { _ = await work.keys(["Esc"], to: sessionId) } }
                        Button("Stop session", role: .destructive) { confirmingStop = true }
                    } label: { Label("Session actions", systemImage: "ellipsis.circle") }
                }
            }
        }
        .confirmationDialog("Stop this session on your Mac?", isPresented: $confirmingStop, titleVisibility: .visible) {
            Button("Stop session", role: .destructive) { Task { _ = await work.stopSession(sessionId) } }
        } message: {
            Text("The agent’s process ends. Its conversation stays readable here and on the Mac.")
        }
        .onAppear { follower.follow() }
        .onDisappear { follower.stop() }
        .onChange(of: showTerminal) { on in if on { follower.watchTerminal() } else { follower.stopTerminal() } }
    }
}

private struct ConversationPane: View {
    @ObservedObject var follower: SessionFollower
    @ObservedObject var work: WorkModel
    let session: WorkSession?

    private enum Item: Identifiable {
        case turn(ConversationTurn)
        case tools([ConversationTurn])
        var id: String {
            switch self {
            case .turn(let turn): return turn.id
            case .tools(let turns): return "tools-\(turns.first?.id ?? "")"
            }
        }
    }

    /** Runs of tool calls fold into one row, as on the Mac. */
    private var items: [Item] {
        var result: [Item] = []
        var tools: [ConversationTurn] = []
        for turn in follower.conversation?.turns ?? [] {
            if turn.role == "tool" { tools.append(turn); continue }
            if !tools.isEmpty { result.append(.tools(tools)); tools = [] }
            result.append(.turn(turn))
        }
        if !tools.isEmpty { result.append(.tools(tools)) }
        return result
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if follower.conversation == nil {
                        ProgressView("Loading the conversation…").frame(maxWidth: .infinity).padding(.top, 40)
                    } else if items.isEmpty {
                        Text("\(session?.agentName ?? "The agent") hasn’t written anything yet. Messages appear as soon as it starts.")
                            .foregroundStyle(.secondary).padding(.top, 24)
                    }
                    ForEach(items) { item in
                        switch item {
                        case .turn(let turn):
                            if let image = turn.image {
                                TurnImageView(work: work, sessionId: follower.sessionId, image: image, caption: turn.text)
                            } else {
                                Bubble(turn: turn)
                            }
                        case .tools(let turns): ToolGroup(turns: turns)
                        }
                    }
                    ForEach(follower.pending) { interaction in
                        InteractionCard(work: work, follower: follower, interaction: interaction)
                    }
                    if let question = follower.conversation?.question, session?.live == true {
                        QuestionCard(work: work, follower: follower, question: question)
                    }
                    if session?.live == true && follower.pending.isEmpty && follower.conversation?.question == nil {
                        if session?.tone == .working {
                            Label("\(session?.agentName ?? "The agent") is working", systemImage: "ellipsis")
                                .font(.footnote).foregroundStyle(.secondary)
                        } else if session?.status == "waiting_input" {
                            Text("\(session?.agentName ?? "The agent") is waiting for you. If it’s asking for a choice the conversation can’t show, open the Terminal.")
                                .font(.footnote).padding(10)
                                .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                        }
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(.horizontal)
            }
            .onChange(of: follower.conversation?.turns.count) { _ in withAnimation { proxy.scrollTo("end", anchor: .bottom) } }
            .onChange(of: follower.pending.count) { _ in withAnimation { proxy.scrollTo("end", anchor: .bottom) } }
            .onAppear { proxy.scrollTo("end", anchor: .bottom) }
        }
    }
}

private struct Bubble: View {
    let turn: ConversationTurn

    var body: some View {
        if turn.role == "user" {
            VStack(alignment: .trailing, spacing: 2) {
                Text(turn.text)
                if turn.via == "phone" { Text("from phone").font(.caption2).opacity(0.7) }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .foregroundStyle(Color(uiColor: .systemBackground))
            .background(Color.primary, in: RoundedRectangle(cornerRadius: 16))
            .frame(maxWidth: .infinity, alignment: .trailing)
            .accessibilityLabel("You\(turn.via == "phone" ? ", from phone" : ""): \(turn.text)")
        } else {
            Text(markdown(turn.text))
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        }
    }

    private func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }
}

/** An image the agent looked at: a thumbnail that opens full screen to zoom. */
private struct TurnImageView: View {
    @ObservedObject var work: WorkModel
    let sessionId: String
    let image: TurnImage
    let caption: String
    @State private var loaded: UIImage?
    @State private var failure: String?
    @State private var showing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let loaded {
                Button { showing = true } label: {
                    Image(uiImage: loaded).resizable().scaledToFit()
                        .frame(maxWidth: .infinity, maxHeight: 280, alignment: .leading)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(caption.isEmpty ? "Image from the agent" : caption)
                .accessibilityHint("Opens full screen")
            } else {
                Label(failure ?? "Loading image…", systemImage: failure == nil ? "photo" : "exclamationmark.circle")
                    .font(.footnote).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 80)
                    .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
            }
            if !caption.isEmpty {
                Text(caption).font(.caption.monospaced()).foregroundStyle(.secondary)
            }
        }
        .task(id: image.id) {
            guard loaded == nil else { return }
            do {
                let data = try await work.image(image.id, in: sessionId)
                if let decoded = UIImage(data: data) { loaded = decoded } else { failure = ImageUnreadable().errorDescription }
            } catch {
                if !Task.isCancelled { failure = Work.imageFailure(error) }
            }
        }
        .fullScreenCover(isPresented: $showing) {
            if let loaded { ZoomableImage(image: loaded, caption: caption) { showing = false } }
        }
    }
}

/** Full screen: pinch to zoom, drag when zoomed, double-tap to reset. */
private struct ZoomableImage: View {
    let image: UIImage
    let caption: String
    let done: () -> Void
    @State private var scale: CGFloat = 1
    @State private var settledScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var settledOffset: CGSize = .zero

    var body: some View {
        NavigationStack {
            GeometryReader { _ in
                Image(uiImage: image).resizable().scaledToFit()
                    .scaleEffect(scale).offset(offset)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .gesture(MagnificationGesture()
                        .onChanged { scale = max(1, settledScale * $0) }
                        .onEnded { _ in settledScale = scale; if scale == 1 { offset = .zero; settledOffset = .zero } })
                    .simultaneousGesture(DragGesture()
                        .onChanged { value in
                            guard scale > 1 else { return }
                            offset = CGSize(width: settledOffset.width + value.translation.width, height: settledOffset.height + value.translation.height)
                        }
                        .onEnded { _ in settledOffset = offset })
                    .onTapGesture(count: 2) {
                        withAnimation { scale = 1; settledScale = 1; offset = .zero; settledOffset = .zero }
                    }
                    .accessibilityLabel(caption.isEmpty ? "Image from the agent" : caption)
            }
            .background(Color.black)
            .navigationTitle(caption)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done", action: done) } }
        }
    }
}

private struct ToolGroup: View {
    let turns: [ConversationTurn]

    var body: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(turns) { turn in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(turn.toolName ?? "Tool").font(.caption.weight(.semibold))
                        Text(turn.text).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(6)
                    }
                }
            }
        } label: {
            Text(turns.count == 1 ? "Used \(turns[0].toolName ?? "a tool")" : "Used \(turns.count) tools")
                .font(.footnote).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4])).foregroundStyle(.secondary.opacity(0.5)))
    }
}

/** An approval or question a Claude hook is holding. */
private struct InteractionCard: View {
    @ObservedObject var work: WorkModel
    @ObservedObject var follower: SessionFollower
    let interaction: Interaction
    @State private var picked: [String: Set<String>] = [:]
    @State private var other = ""
    @State private var busy = false

    private var questionIds: [String] {
        var seen: [String] = []
        for choice in interaction.choices { if let id = choice.questionId, !seen.contains(id) { seen.append(id) } }
        return seen
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(interaction.kind == "approval" ? "Wants to go ahead" : "Question")
                .font(.caption.weight(.bold)).foregroundStyle(.orange).textCase(.uppercase)
            Text(interaction.question).font(.subheadline.weight(.semibold))
            if let context = interaction.context {
                Text(context).font(.caption.monospaced()).padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: 8))
            }
            if interaction.kind == "approval" {
                if interaction.canRespond {
                    HStack {
                        Button("Deny") { act { await work.decide(interaction, approve: false, in: follower.sessionId) } }
                            .buttonStyle(.bordered).frame(maxWidth: .infinity)
                        Button("Allow") { act { await work.decide(interaction, approve: true, in: follower.sessionId) } }
                            .buttonStyle(.borderedProminent).frame(maxWidth: .infinity)
                    }
                    .disabled(busy)
                } else if let reason = interaction.unavailableReason {
                    Text(reason).font(.footnote).foregroundStyle(.secondary)
                }
            } else {
                ForEach(questionIds, id: \.self) { questionId in
                    if questionIds.count > 1 { Text(questionId).font(.footnote.weight(.semibold)) }
                    let choices = interaction.choices.filter { $0.questionId == questionId }
                    ForEach(choices) { choice in
                        Button { toggle(choice, in: questionId) } label: {
                            OptionRow(label: choice.label, description: choice.description, selected: picked[questionId]?.contains(choice.id) == true)
                        }
                        .buttonStyle(.plain)
                    }
                }
                if interaction.allowsFreeText { TextField("Or type an answer", text: $other) }
                Button("Answer") { submitAnswers() }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy || !interaction.canRespond || (questionIds.contains { (picked[$0] ?? []).isEmpty } && other.isEmpty))
            }
        }
        .padding(12)
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.orange.opacity(0.6)))
    }

    private func toggle(_ choice: InteractionChoice, in questionId: String) {
        var set = picked[questionId] ?? []
        if choice.multiple == true { if set.contains(choice.id) { set.remove(choice.id) } else { set.insert(choice.id) } }
        else { set = [choice.id] }
        picked[questionId] = set
    }

    private func submitAnswers() {
        var answers: [String: [String]] = [:]
        for questionId in questionIds { answers[questionId] = Array(picked[questionId] ?? []) }
        let text = other.trimmingCharacters(in: .whitespaces)
        if !text.isEmpty, let first = questionIds.first, answers[first]?.isEmpty ?? true { answers[first] = [text] }
        act { await work.answer(interaction, with: answers, in: follower.sessionId) }
    }

    private func act(_ action: @escaping () async -> Bool) {
        busy = true
        Task {
            if await action() { await follower.refresh() }
            busy = false
        }
    }
}

/** The agent's open multiple-choice question from its transcript. */
private struct QuestionCard: View {
    @ObservedObject var work: WorkModel
    @ObservedObject var follower: SessionFollower
    let question: OpenQuestion
    @State private var drafts: [QuestionAnswer] = []
    @State private var busy = false
    @State private var sent = false

    var body: some View {
        if !sent {
            VStack(alignment: .leading, spacing: 10) {
                Text("Question").font(.caption.weight(.bold)).foregroundStyle(.orange).textCase(.uppercase)
                ForEach(Array(question.questions.enumerated()), id: \.offset) { index, item in
                    VStack(alignment: .leading, spacing: 6) {
                        Text([item.header, item.question].compactMap { $0 }.joined(separator: " · ")).font(.subheadline.weight(.semibold))
                        ForEach(Array(item.options.enumerated()), id: \.offset) { optionIndex, option in
                            Button { pick(optionIndex, in: index, multiple: item.multiSelect) } label: {
                                OptionRow(label: option.label, description: option.description, selected: draft(index).selected.contains(optionIndex))
                            }
                            .buttonStyle(.plain)
                        }
                        TextField("Or type your own answer", text: Binding(
                            get: { draft(index).other ?? "" },
                            set: { value in ensure(index); drafts[index].other = value.isEmpty ? nil : value }))
                    }
                }
                if question.canAnswer == false {
                    Text("AgentDeck can’t reach this session’s menu. Answer it in the Terminal.").font(.footnote).foregroundStyle(.secondary)
                } else {
                    Button(busy ? "Sending…" : "Answer") { submit() }
                        .buttonStyle(.borderedProminent)
                        .disabled(busy || !complete)
                }
            }
            .padding(12)
            .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.orange.opacity(0.6)))
            .onChange(of: question.id) { _ in drafts = []; sent = false }
        }
    }

    private var complete: Bool {
        question.questions.indices.allSatisfy { !draft($0).selected.isEmpty || !(draft($0).other ?? "").trimmingCharacters(in: .whitespaces).isEmpty }
    }

    private func draft(_ index: Int) -> QuestionAnswer { index < drafts.count ? drafts[index] : QuestionAnswer(selected: [], other: nil) }

    private func ensure(_ index: Int) {
        while drafts.count <= index { drafts.append(QuestionAnswer(selected: [], other: nil)) }
    }

    private func pick(_ option: Int, in index: Int, multiple: Bool) {
        ensure(index)
        if multiple {
            if let at = drafts[index].selected.firstIndex(of: option) { drafts[index].selected.remove(at: at) } else { drafts[index].selected.append(option) }
        } else {
            drafts[index].selected = [option]
        }
    }

    private func submit() {
        let answers = question.questions.indices.map { index -> QuestionAnswer in
            var answer = draft(index)
            answer.other = answer.other?.trimmingCharacters(in: .whitespaces)
            if answer.other?.isEmpty == true { answer.other = nil }
            return answer
        }
        busy = true
        Task {
            if await work.answer(question, with: answers, in: follower.sessionId) {
                sent = true
                await follower.refresh()
            }
            busy = false
        }
    }
}

private struct OptionRow: View {
    let label: String
    let description: String?
    let selected: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(selected ? Color.accentColor : .secondary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(.subheadline.weight(.medium))
                if let description { Text(description).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer(minLength: 0)
        }
        .padding(8)
        .background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(selected ? Color.accentColor : Color.secondary.opacity(0.3)))
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private struct TerminalPane: View {
    @ObservedObject var follower: SessionFollower
    @ObservedObject var work: WorkModel
    let sessionId: String
    let live: Bool
    let available: Bool

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading) {
                        if !available {
                            Text("This session runs in a terminal app on the Mac, so its screen isn’t shared. Use the conversation, or continue on the Mac.")
                                .foregroundStyle(.secondary)
                        } else if let screen = follower.screen {
                            Text(screen.text.isEmpty ? "Nothing on screen yet." : screen.text)
                                .font(.system(size: 11, design: .monospaced))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        } else {
                            ProgressView("Waiting for the terminal…").frame(maxWidth: .infinity).padding(.top, 40)
                        }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding(10)
                }
                .background(Color(uiColor: .secondarySystemBackground))
                .onChange(of: follower.screen?.seq) { _ in proxy.scrollTo("end", anchor: .bottom) }
            }
            if live {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(Work.keys, id: \.self) { key in
                            Button(key) { Task { _ = await work.keys([key], to: sessionId) } }
                                .font(.footnote.weight(.semibold))
                                .buttonStyle(.bordered)
                                .accessibilityLabel(accessibleName(key))
                        }
                    }
                    .padding(.horizontal).padding(.vertical, 6)
                }
            }
        }
    }

    private func accessibleName(_ key: String) -> String {
        switch key {
        case "↑": return "Up arrow"
        case "↓": return "Down arrow"
        case "←": return "Left arrow"
        case "→": return "Right arrow"
        case "Esc": return "Escape"
        case "Ctrl-C": return "Control C"
        default: return key
        }
    }
}

private struct Composer: View {
    @ObservedObject var work: WorkModel
    let sessionId: String
    let agent: String
    let placeholder: String
    @State private var draft = ""
    @State private var sending = false
    @State private var skills: [Skill]?
    @FocusState private var focused: Bool

    struct Skill: Decodable, Identifiable, Equatable { let name: String; let description: String?; var id: String { name } }
    private struct SkillList: Decodable { let skills: [Skill] }

    /** Typing "/" lists the session's skills, as on the Mac (Claude sessions). */
    private var slashMatches: [Skill] {
        guard agent == "claude", draft.hasPrefix("/"), !draft.contains(" ") else { return [] }
        let query = draft.dropFirst().lowercased()
        return (skills ?? []).filter { query.isEmpty || $0.name.lowercased().contains(query) }.prefix(6).map { $0 }
    }

    var body: some View {
        VStack(spacing: 0) {
            if !slashMatches.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(slashMatches) { skill in
                        Button { draft = "/\(skill.name) " } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("/\(skill.name)").font(.subheadline.weight(.semibold))
                                if let description = skill.description { Text(description).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal).padding(.vertical, 6)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .background(Color(uiColor: .secondarySystemBackground))
            }
            Divider()
            HStack(alignment: .bottom, spacing: 8) {
                TextField(placeholder, text: $draft, axis: .vertical)
                    .lineLimit(1...5)
                    .focused($focused)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
                Button { send() } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.title)
                }
                .disabled(sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("Send")
            }
            .padding(.horizontal).padding(.vertical, 8)
        }
        .onChange(of: draft) { value in
            if value.hasPrefix("/") && skills == nil && agent == "claude" { Task { await loadSkills() } }
        }
    }

    private func loadSkills() async {
        skills = []
        let list: SkillList? = try? await work.client.get("api/sessions/\(sessionId)/skills")
        skills = list?.skills ?? []
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        sending = true
        Task {
            if await work.send(text, to: sessionId) { draft = "" }
            sending = false
        }
    }
}

// MARK: - A Run

private struct RunScreen: View {
    @ObservedObject var work: WorkModel
    let runId: String
    @StateObject private var follower: RunFollower
    @State private var input = ""
    @State private var feedback = ""
    @State private var busy = false
    @State private var confirmingCancel = false
    @State private var confirmingPublish = false

    init(work: WorkModel, runId: String) {
        self.work = work
        self.runId = runId
        _follower = StateObject(wrappedValue: RunFollower(runId: runId, work: work))
    }

    var body: some View {
        List {
            WorkNoticeRow(work: work)
            if let run = follower.detail {
                header(run)
                if let attention = run.pendingAttention { attentionSection(run, attention) }
                if let result = run.result { resultSection(run, result) }
                if run.actions.review { reviewSection(run) }
                Section("Activity") {
                    ForEach(run.timeline.reversed()) { item in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Circle().fill(color(item.tone)).frame(width: 8, height: 8).accessibilityHidden(true)
                                Text(item.label).font(.subheadline.weight(.semibold))
                                Spacer()
                                Text(Format.time(item.at)).font(.caption2).foregroundStyle(.secondary)
                            }
                            if let detail = item.detail { Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(4) }
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            } else if follower.missing {
                Text("This Run is no longer on the Mac.").foregroundStyle(.secondary)
            } else {
                ProgressView("Loading the Run…")
            }
        }
        .navigationTitle(follower.detail?.objective ?? "Run")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let actions = follower.detail?.actions, actions.pause || actions.resume || actions.cancel || actions.retry || actions.start || actions.prepare {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        if actions.prepare { Button("Prepare") { act("prepare") } }
                        if actions.start { Button("Start") { act("start") } }
                        if actions.pause { Button("Pause") { act("pause") } }
                        if actions.resume { Button("Resume") { act("resume") } }
                        if actions.retry { Button("Try again") { act("attempts") } }
                        if actions.cancel { Button("Cancel Run", role: .destructive) { confirmingCancel = true } }
                    } label: { Label("Run actions", systemImage: "ellipsis.circle") }
                }
            }
        }
        .confirmationDialog("Cancel this Run?", isPresented: $confirmingCancel, titleVisibility: .visible) {
            Button("Cancel Run", role: .destructive) { act("cancel") }
        }
        .refreshable { await follower.refresh() }
        .onAppear { follower.follow() }
        .onDisappear { follower.stop() }
    }

    @ViewBuilder private func header(_ run: RunDetail) -> some View {
        Section {
            HStack {
                Text(run.objective).font(.headline)
                Spacer()
                StatusChip(label: run.review == "ready_to_review" ? "Ready to review" : Work.runStatusLabel(run.status),
                           tone: run.pendingAttention != nil ? .waiting : run.review == "ready_to_review" ? .review : run.status.hasPrefix("failed") ? .failed : Work.settledRunStatuses.contains(run.status) ? .ended : .working)
            }
            LabeledContent("Repository", value: run.repoName)
            LabeledContent("Agent", value: run.runtime == "codex" ? "Codex" : run.runtime == "claude" ? "Claude" : "Auto")
            LabeledContent("Started from", value: run.baseReference)
            if let elapsed = run.elapsedMinutes {
                LabeledContent("Time", value: run.budgetMinutes.map { "\(elapsed) of \($0) min" } ?? "\(elapsed) min")
            }
            if run.attemptCount > 1 { LabeledContent("Attempt", value: "\(run.attemptCount)") }
            LabeledContent("When done", value: Work.deliveryLabel(run.delivery))
        }
        if !run.acceptanceCriteria.isEmpty {
            Section("Done when") {
                ForEach(run.acceptanceCriteria, id: \.self) { Text("• \($0)") }
            }
        }
    }

    @ViewBuilder private func attentionSection(_ run: RunDetail, _ attention: RunAttention) -> some View {
        Section {
            Text(attention.reason)
            if attention.kind == "input" {
                TextField("Your answer", text: $input, axis: .vertical)
                Button("Send") { act { await work.attention(run.id, attention, input: input) } }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy || input.trimmingCharacters(in: .whitespaces).isEmpty)
            } else {
                HStack {
                    Button("Deny") { act { await work.attention(run.id, attention, approve: false) } }.buttonStyle(.bordered)
                    Spacer()
                    Button("Approve") { act { await work.attention(run.id, attention, approve: true) } }.buttonStyle(.borderedProminent)
                }
                .disabled(busy)
            }
        } header: { Text(attention.kind == "input" ? "Needs your input" : "Needs your OK") }
    }

    @ViewBuilder private func resultSection(_ run: RunDetail, _ result: RunResultInfo) -> some View {
        Section {
            if let summary = result.summary { Text(summary) }
            if let notes = result.notes { Label(notes, systemImage: "exclamationmark.triangle").foregroundStyle(.orange) }
            ForEach(result.checks, id: \.name) { check in
                Label("\(check.name): \(check.passed ? "passed" : "failed")", systemImage: check.passed ? "checkmark.circle" : "xmark.circle")
                    .foregroundStyle(check.passed ? .green : .red)
            }
            if let commit = result.commit {
                LabeledContent("Commit", value: "\(commit.sha.prefix(7)) on \(commit.branch)")
            }
            if result.applied { Label("Applied to the repository", systemImage: "checkmark.seal") }
            if run.worktreePath != nil && !result.changedFiles.isEmpty {
                NavigationLink {
                    RunChangesView(follower: follower)
                } label: {
                    Text("\(result.changedFiles.count) file\(result.changedFiles.count == 1 ? "" : "s") changed")
                }
            }
            if run.actions.apply {
                Button("Apply to repository") { act("apply") }.disabled(busy)
            }
            if run.actions.publish {
                Button("Open draft pull request") { confirmingPublish = true }.disabled(busy)
                    .confirmationDialog("Push this Run’s branch and open a draft pull request?", isPresented: $confirmingPublish, titleVisibility: .visible) {
                        Button("Open draft pull request") { act { await work.publish(run.id, target: "draft-pull-request") } }
                        Button("Push branch only") { act { await work.publish(run.id, target: "push") } }
                    }
            }
            if let publication = run.publication {
                if let url = publication.url, let link = URL(string: url) {
                    Link("Pull request (\(publication.state))", destination: link)
                } else {
                    LabeledContent("Publishing", value: publication.state)
                }
            }
        } header: { Text("Result · \(Work.runStatusLabel(result.outcome))") }
    }

    @ViewBuilder private func reviewSection(_ run: RunDetail) -> some View {
        Section {
            TextField("Comment or changes to ask for", text: $feedback, axis: .vertical)
            HStack {
                Button("Request changes") { review(run, "changes_requested") }
                    .buttonStyle(.bordered)
                    .disabled(busy || feedback.trimmingCharacters(in: .whitespaces).isEmpty)
                Spacer()
                Button("Mark reviewed") { review(run, "reviewed") }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy)
            }
        } header: { Text("Review") } footer: {
            Text(run.review == "ready_to_review" ? "Shared with the Mac’s review of this Run." : "Review: \(run.review.replacingOccurrences(of: "_", with: " ")).")
        }
    }

    private func review(_ run: RunDetail, _ decision: String) {
        let text = feedback.trimmingCharacters(in: .whitespacesAndNewlines)
        act {
            let done = await work.feedback(run.id, text: text.isEmpty ? "Reviewed on phone." : text, decision: decision)
            if done { feedback = "" }
            return done
        }
    }

    private func act(_ verb: String) { act { await work.runAction(verb, runId) } }

    private func act(_ action: @escaping () async -> Bool) {
        busy = true
        Task {
            if await action() { input = ""; await follower.refresh() }
            busy = false
        }
    }

    private func color(_ tone: String) -> Color {
        switch tone {
        case "done": return .green
        case "now": return .orange
        case "failed": return .red
        default: return .secondary
        }
    }
}

private struct RunChangesView: View {
    @ObservedObject var follower: RunFollower
    @State private var summary: DiffSummary?
    @State private var loading = true

    var body: some View {
        List {
            if loading {
                ProgressView("Reading the changes…")
            } else if let files = summary?.files, !files.isEmpty {
                ForEach(files) { file in
                    NavigationLink {
                        FileDiffView(follower: follower, path: file.path)
                    } label: {
                        HStack {
                            Text(file.path).font(.footnote.monospaced()).lineLimit(2)
                            Spacer()
                            if file.binary == true { Text("binary").font(.caption).foregroundStyle(.secondary) }
                            else {
                                Text("+\(file.additions)").font(.caption.monospaced()).foregroundStyle(.green)
                                Text("−\(file.deletions)").font(.caption.monospaced()).foregroundStyle(.red)
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            } else {
                Text("No changes to show.").foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Changes")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            summary = await follower.diff()
            loading = false
        }
    }
}

private struct FileDiffView: View {
    @ObservedObject var follower: RunFollower
    let path: String
    @State private var diff: FileDiff?
    @State private var loading = true

    var body: some View {
        ScrollView {
            if loading {
                ProgressView().padding(.top, 40)
            } else if let diff {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(diff.diff.split(separator: "\n", omittingEmptySubsequences: false).enumerated()), id: \.offset) { _, line in
                        Text(String(line).isEmpty ? " " : String(line))
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(line.hasPrefix("+") ? Color.green : line.hasPrefix("-") ? Color.red : line.hasPrefix("@@") ? Color.blue : Color.primary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(line.hasPrefix("+") ? Color.green.opacity(0.08) : line.hasPrefix("-") ? Color.red.opacity(0.08) : Color.clear)
                    }
                    if diff.truncated { Text("The rest of this diff is too long to show here.").font(.footnote).foregroundStyle(.secondary).padding(.top) }
                }
                .padding(10)
                .textSelection(.enabled)
            } else {
                Text("This diff couldn’t be read.").foregroundStyle(.secondary).padding()
            }
        }
        .navigationTitle((path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            diff = await follower.fileDiff(path)
            loading = false
        }
    }
}
