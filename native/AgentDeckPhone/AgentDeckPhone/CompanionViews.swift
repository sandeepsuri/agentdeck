import SwiftUI

// Issue #87: Ask, Tasks, and Needs you on the owner's phone. System fonts,
// colors, and list styles carry Dynamic Type, VoiceOver, and light and dark
// appearance; status is always written out, never shown by color alone.

struct CompanionView: View {
    @ObservedObject var model: CompanionModel
    let onForget: () -> Void
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            switch model.link {
            case .connecting:
                VStack(spacing: 16) {
                    ProgressView("Connecting to your Mac…")
                    NoticeRow(model: model)
                    if model.notice != nil { Button("Try again") { Task { await model.refresh() } } }
                }
                .padding()
            case .unavailable: MacUnavailableView(model: model, onForget: onForget)
            case .live:
                TabView(selection: $model.tab) {
                    NeedsYouView(model: model)
                        .tabItem { Label("Needs you", systemImage: "exclamationmark.bubble") }
                        .badge(model.needs.count)
                        .tag(CompanionModel.Tab.needsYou)
                    AskView(model: model)
                        .tabItem { Label("Ask", systemImage: "text.bubble") }
                        .tag(CompanionModel.Tab.ask)
                    TasksView(model: model, onForget: onForget)
                        .tabItem { Label("Tasks", systemImage: "checklist") }
                        .tag(CompanionModel.Tab.tasks)
                }
            }
        }
        .onAppear { model.follow() }
        .onDisappear { model.stop() }
        .onChange(of: scenePhase) { phase in
            if phase == .active { model.follow() } else if phase == .background { model.stop() }
        }
    }
}

private struct MacUnavailableView: View {
    @ObservedObject var model: CompanionModel
    let onForget: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "desktopcomputer.trianglebadge.exclamationmark")
                .font(.largeTitle)
                .accessibilityHidden(true)
            Text("Mac unavailable").font(.title2.bold())
            Text("AgentDeck on your Mac isn’t answering. Tasks and decisions will appear again when it’s back; nothing here is shown until then.")
                .multilineTextAlignment(.center)
            if let lastReached = model.lastReached {
                Text("Last reached \(lastReached.formatted(date: .omitted, time: .shortened))").font(.footnote).foregroundStyle(.secondary)
            }
            Text("Check that the Mac is awake, AgentDeck is open, and both devices are on Tailscale.")
                .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Button("Try again") { Task { await model.refresh() } }
                .buttonStyle(.borderedProminent)
            Button("Forget this Mac", role: .destructive, action: onForget)
        }
        .padding()
        .frame(maxWidth: 480)
    }
}

// MARK: - Needs you

private struct NeedsYouView: View {
    @ObservedObject var model: CompanionModel
    @State private var path: [String] = []

    var body: some View {
        NavigationStack(path: $path) {
            List {
                NoticeRow(model: model)
                if model.needs.isEmpty {
                    Text("Nothing needs you. Plans to approve and tasks that went wrong show up here.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(model.needs) { need in
                        NavigationLink(value: need.taskId) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(need.kind == .decision ? "Decision" : "Problem")
                                    .font(.caption.weight(.semibold)).foregroundStyle(need.kind == .decision ? Color.accentColor : .red)
                                Text(need.title).font(.headline)
                                Text(need.reason).font(.subheadline).foregroundStyle(.secondary)
                            }
                            .padding(.vertical, 4)
                            .accessibilityElement(children: .combine)
                        }
                    }
                }
            }
            .navigationTitle("Needs you")
            .navigationDestination(for: String.self) { TaskDetailView(model: model, taskId: $0) }
            .refreshable { await model.refresh() }
        }
    }
}

// MARK: - Ask

private struct AskView: View {
    @ObservedObject var model: CompanionModel
    @State private var grantId: String?
    @State private var listing: PdfListing?
    @State private var selected: Set<String> = []
    @State private var loading = false
    @State private var busy = false

    private var grant: FolderGrant? { model.activeGrants.first { $0.id == grantId } }

    var body: some View {
        NavigationStack {
            Form {
                NoticeRow(model: model)
                if model.activeGrants.isEmpty {
                    Section {
                        Text("No folders yet. On your Mac, open Personal tasks and choose a folder, such as a folder of statements. It appears here.")
                    }
                } else {
                    Section {
                        Picker("Folder", selection: $grantId) {
                            Text("Choose…").tag(String?.none)
                            ForEach(model.activeGrants) { grant in
                                Text(grant.name).tag(Optional(grant.id))
                            }
                        }
                    } header: { Text("What should AgentDeck look at?") } footer: {
                        Text("Only folders you chose on your Mac are listed.")
                    }
                    if let grant { pdfSection(grant) }
                }
            }
            .navigationTitle("Ask")
            .onChange(of: grantId) { _ in Task { await load() } }
        }
    }

    @ViewBuilder private func pdfSection(_ grant: FolderGrant) -> some View {
        if loading {
            Section { ProgressView("Looking for PDFs in \(grant.name)…") }
        } else if let listing {
            if listing.files.isEmpty {
                Section { Text("No PDFs in \(grant.name).") }
            } else {
                Section {
                    Toggle("Select all", isOn: Binding(
                        get: { selected.count == listing.files.count },
                        set: { selected = $0 ? Set(listing.files.map(\.relativePath)) : [] }))
                    ForEach(listing.files) { file in
                        Toggle(isOn: Binding(
                            get: { selected.contains(file.relativePath) },
                            set: { if $0 { selected.insert(file.relativePath) } else { selected.remove(file.relativePath) } })) {
                            VStack(alignment: .leading) {
                                Text(file.relativePath)
                                Text(Format.bytes(file.size)).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                } header: { Text("PDFs in \(grant.name)") } footer: {
                    if listing.truncated { Text("Only the first \(listing.files.count) PDFs are shown.") }
                }
                Section {
                    Button { submit(.filingProposal, grant) } label: {
                        Text("Suggest how to file \(Format.pdfs(selected.count))").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    Button { submit(.inventory, grant) } label: {
                        Text("Just list what’s in them").frame(maxWidth: .infinity)
                    }
                } footer: {
                    Text("A filing plan lets a confined agent read the selected PDFs and suggest names and folders. Nothing moves until you approve the plan.")
                }
                .disabled(busy || selected.isEmpty)
            }
        }
    }

    private func load() async {
        listing = nil
        selected = []
        guard let grant else { return }
        loading = true
        defer { loading = false }
        guard let next = try? await model.pdfs(in: grant) else { return }
        listing = next
        selected = Set(next.files.map(\.relativePath))
    }

    private func submit(_ kind: TaskKind, _ grant: FolderGrant) {
        let files = (listing?.files ?? []).map(\.relativePath).filter(selected.contains)
        busy = true
        Task {
            if await model.ask(kind: kind, grant: grant, files: files) { grantId = nil }
            busy = false
        }
    }
}

// MARK: - Tasks

private struct TasksView: View {
    @ObservedObject var model: CompanionModel
    let onForget: () -> Void

    var body: some View {
        NavigationStack(path: $model.tasksPath) {
            List {
                NoticeRow(model: model)
                if model.tasks.isEmpty {
                    Text("No tasks yet. Start one from Ask.").foregroundStyle(.secondary)
                }
                ForEach(model.tasks) { task in
                    NavigationLink(value: task.id) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(task.title).font(.headline)
                            Text("\(task.statusLabel) · \(Format.time(task.submittedAt))").font(.subheadline).foregroundStyle(.secondary)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
                Section {
                    Button("Forget this Mac", role: .destructive, action: onForget)
                } footer: {
                    Text("Removes this phone’s saved credential. Revoke it on the Mac too, under Settings › Owner phones.")
                }
            }
            .navigationTitle("Tasks")
            .navigationDestination(for: String.self) { TaskDetailView(model: model, taskId: $0) }
            .refreshable { await model.refresh() }
        }
    }
}

private struct TaskDetailView: View {
    @ObservedObject var model: CompanionModel
    let taskId: String
    @State private var busy = false

    var body: some View {
        if let task = model.task(taskId) {
            List {
                NoticeRow(model: model)
                Section {
                    LabeledContent("Status", value: task.statusLabel)
                    LabeledContent("Asked by", value: "\(task.submittedBy.displayName) on \(task.submittedBy.device)")
                    LabeledContent("Folder", value: task.grant.name + (task.grant.revoked ? " (access revoked)" : ""))
                    LabeledContent("Submitted", value: Format.time(task.submittedAt))
                }
                if let failure = task.failure {
                    Section("What went wrong") {
                        Text(failure)
                        if task.status == .failed {
                            Button("Try again") { act { await model.retryTask(task) } }.disabled(busy)
                        }
                    }
                }
                if let result = task.result {
                    if result.isProposal {
                        ProposalSections(model: model, task: task, result: result)
                    } else {
                        InventorySection(result: result)
                    }
                }
                Section("Activity") {
                    ForEach(task.activity.reversed()) { entry in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(entry.message)
                            Text(Format.time(entry.at)).font(.caption).foregroundStyle(.secondary)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
            .navigationTitle(task.title)
            .navigationBarTitleDisplayMode(.inline)
            .refreshable { await model.refresh() }
        } else {
            Text("This task is no longer on the Mac.").foregroundStyle(.secondary)
        }
    }

    private func act(_ action: @escaping () async -> Bool) {
        busy = true
        Task { _ = await action(); busy = false }
    }
}

private struct InventorySection: View {
    let result: TaskResult

    var body: some View {
        let files = result.files ?? []
        Section {
            ForEach(files) { file in
                VStack(alignment: .leading, spacing: 2) {
                    Text(file.path + (file.encrypted ? " (locked)" : ""))
                    Text([file.pageCount.map { "\($0) page\($0 == 1 ? "" : "s")" } ?? "Pages unknown", Format.bytes(file.size)].joined(separator: " · "))
                        .font(.caption).foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
            }
            ForEach(result.skipped) { Text("\($0.path): \($0.reason)").foregroundStyle(.secondary) }
        } header: {
            Text("\(Format.pdfs(files.count)) · \(Format.bytes(result.totalBytes ?? 0))")
        }
    }
}

private struct ProposalSections: View {
    @ObservedObject var model: CompanionModel
    let task: PersonalTask
    let result: TaskResult
    @State private var replacing: Set<String> = []
    @State private var confirming = false
    @State private var busy = false

    private var entries: [PlanEntry] { result.entries ?? [] }
    private var moving: Int { entries.filter { !$0.unchanged && (!$0.replacesFile || replacing.contains($0.source)) }.count }

    var body: some View {
        let receipts = Dictionary(uniqueKeysWithValues: (task.filing?.receipts ?? []).map { ($0.source, $0) })
        Section {
            ForEach(entries) { entry in
                VStack(alignment: .leading, spacing: 4) {
                    Text(entry.source).font(.body.weight(.semibold))
                    Text("→ \(entry.destination.isEmpty ? "" : entry.destination + "/")\(entry.newName)")
                    ForEach(entry.warnings, id: \.kind) { warning in
                        Label(warning.message, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.orange)
                    }
                    if let receipt = receipts[entry.source] {
                        Text(receipt.label + (receipt.reason.map { ": \($0)" } ?? "")).font(.footnote.weight(.semibold))
                    }
                    if task.filing == nil && entry.replacesFile {
                        Toggle("Replace the existing file", isOn: Binding(
                            get: { replacing.contains(entry.source) },
                            set: { if $0 { replacing.insert(entry.source) } else { replacing.remove(entry.source) } }))
                            .font(.footnote)
                    }
                }
                .padding(.vertical, 2)
            }
            ForEach(result.unplanned ?? []) { Text("\($0.path) stays where it is: \($0.reason)").foregroundStyle(.secondary) }
            ForEach(result.skipped) { Text("\($0.path) was skipped: \($0.reason)").foregroundStyle(.secondary) }
        } header: {
            Text("Filing plan · \(Format.pdfs(entries.count))")
        }
        decisionSection
    }

    @ViewBuilder private var decisionSection: some View {
        if let filing = task.filing {
            Section {
                Text(headline(filing))
                Text("Approved by \(filing.approvedBy.displayName) on \(filing.approvedBy.device), \(Format.time(filing.approvedAt)).")
                    .font(.footnote).foregroundStyle(.secondary)
                if filing.state == "finished" {
                    if filing.receipts.contains(where: { $0.state == "failed" }) {
                        Button("Retry files not moved") { act { await model.filing(.retry, task) } }.disabled(busy)
                    }
                    if filing.receipts.contains(where: { $0.state == "moved" && $0.undoState != "undone" }) {
                        Button("Undo recorded moves") { act { await model.filing(.undo, task) } }.disabled(busy)
                    }
                }
            } header: { Text("Result") }
        } else if task.status == .completed {
            Section {
                Button {
                    confirming = true
                } label: {
                    Text(busy ? "Approving…" : "Approve and move \(Format.pdfs(moving))").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy || moving == 0)
                .confirmationDialog("Move \(Format.pdfs(moving)) on your Mac?", isPresented: $confirming, titleVisibility: .visible) {
                    Button("Approve and move") { act { await model.approve(task, replacing: replacing) } }
                } message: {
                    Text("AgentDeck checks each file again first and leaves anything that changed where it is.")
                }
            } footer: {
                Text("Approves exactly this plan (fingerprint \(String((result.planDigest ?? "").prefix(12)))), once. If the plan changes on the Mac, it has to be reviewed again.")
            }
        }
    }

    private func headline(_ filing: Filing) -> String {
        let planned = filing.receipts.filter { $0.state != "skipped" }
        let moved = planned.filter { $0.state == "moved" && $0.undoState != "undone" }.count
        if filing.state == "approved" || filing.state == "executing" { return "Moving… \(moved) of \(planned.count) moved so far." }
        if filing.state == "expired" { return "The approval expired before the moves started. Nothing was moved." }
        let restored = planned.filter { $0.undoState == "undone" }.count
        let uncertain = planned.filter { $0.state == "uncertain" }.count
        let notMoved = planned.count - moved - restored - uncertain
        return "Moved \(moved) of \(planned.count)"
            + (restored > 0 ? " · \(restored) restored" : "")
            + (notMoved > 0 ? " · \(notMoved) not moved" : "")
            + (uncertain > 0 ? " · \(uncertain) need checking" : "") + "."
    }

    private func act(_ action: @escaping () async -> Bool) {
        busy = true
        Task { _ = await action(); busy = false }
    }
}

/** The Mac's own reason for refusing the last request, until the next one. */
private struct NoticeRow: View {
    @ObservedObject var model: CompanionModel

    var body: some View {
        if let notice = model.notice {
            Label(notice, systemImage: "exclamationmark.circle")
                .foregroundStyle(.red)
                .accessibilityLabel("AgentDeck says: \(notice)")
        }
    }
}
