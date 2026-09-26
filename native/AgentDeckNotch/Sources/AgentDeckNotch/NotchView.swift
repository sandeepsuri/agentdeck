import AppKit
import SwiftUI

private enum Palette {
    static let surface = Color(red: 0.09, green: 0.10, blue: 0.13)
    static let card = Color.white.opacity(0.07)
    static let text = Color.white
    static let secondary = Color.white.opacity(0.72)
    static let accent = Color(red: 1, green: 0.76, blue: 0.34)
}

struct MenuBarPillView: View {
    @ObservedObject var store: CompanionStore
    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "exclamationmark.circle.fill").font(.system(size: 11))
                .foregroundStyle(store.display.actionableCount > 0 ? Palette.accent : .secondary)
            Text(store.connected ? "\(store.display.actionableCount)" : "—")
                .foregroundStyle(store.display.actionableCount > 0 ? Palette.accent : .primary)
                .frame(width: 22, alignment: .trailing)
            Image(systemName: "circle.fill").font(.system(size: 6))
                .foregroundStyle(store.connected && store.display.runningCount > 0 ? .green : .secondary)
            Text(store.connected ? "\(store.display.runningCount)" : "—").frame(width: 22, alignment: .leading)
                .foregroundStyle(.secondary)
        }
        .font(.system(size: 11, weight: .semibold).monospacedDigit())
        .frame(width: CompanionGeometry.menuWidth, height: CompanionGeometry.menuHeight)
        .allowsHitTesting(false)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(store.connected ? "AgentDeck, \(store.display.actionableCount) need you, \(store.display.runningCount) running" : "AgentDeck reconnecting")
    }
}

struct DetachedDashboardView: View {
    @ObservedObject var store: CompanionStore
    let width: CGFloat
    let height: CGFloat
    init(store: CompanionStore, width: CGFloat = CompanionGeometry.popoverWidth,
         height: CGFloat = CompanionGeometry.popoverHeight) {
        self.store = store
        self.width = width
        self.height = height
    }
    private var display: CompanionDisplay { store.display }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Image(systemName: "square.stack.3d.up.fill").foregroundStyle(Palette.accent)
                Text("AgentDeck").font(.headline)
                Spacer()
                Button { store.showSettings() } label: { Image(systemName: "gearshape") }
                    .help("Companion settings")
            }
            .padding(16)
            .accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: 5) {
                Text("Total usage this month").font(.caption.weight(.semibold))
                if let usage = store.usage, usage.indexedAt != nil {
                    Text("\(usage.month.totalTokens.formatted()) tokens")
                        .font(.system(size: 18, weight: .semibold))
                    Text(usage.month.costLabel).font(.caption).foregroundStyle(Palette.secondary)
                    Text("Claude Code + Codex · Indexed usage · API estimate, not your bill")
                        .font(.caption2).foregroundStyle(Palette.secondary)
                } else {
                    Text("Usage unavailable").font(.caption).foregroundStyle(Palette.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(Palette.card, in: RoundedRectangle(cornerRadius: 10))
            .padding(.horizontal, 14)
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    SectionTitle(title: "Needs you", count: display.actionableCount)
                    ForEach(display.runs) { run in
                        Button { store.openRun(run.runId) } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text("Run · Input needed").font(.caption.weight(.bold)).foregroundStyle(Palette.accent)
                                    Spacer()
                                    Text("Open Run →").font(.caption)
                                }
                                Text(run.objective).font(.subheadline.weight(.semibold)).lineLimit(1)
                                Text(run.reason).font(.caption).lineLimit(2).foregroundStyle(Palette.secondary)
                                Text("Requested \(relativeTime(run.requestedAt))").font(.caption2).foregroundStyle(Palette.secondary)
                            }
                            .rowSurface()
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Run, input needed, \(run.objective), \(run.reason), open Run")
                    }
                    ForEach(display.attention) { agent in sessionRow(agent) }
                    if display.actionableCount == 0 {
                        Text(store.connected ? "Nothing needs your input" : "Reconnecting to AgentDeck")
                            .font(.caption).foregroundStyle(Palette.secondary).padding(.horizontal, 8)
                    }
                    SectionTitle(title: "In progress", count: display.runningCount)
                    ForEach(display.progress) { agent in sessionRow(agent) }
                    if display.runningCount == 0 {
                        Text(store.connected ? "No active sessions" : "Status will return with the connection")
                            .font(.caption).foregroundStyle(Palette.secondary).padding(.horizontal, 8)
                    }
                }
                .padding(14)
            }
            Button { store.openAllAgents() } label: {
                HStack { Text("Open AgentDeck"); Spacer(); Text("⌘J") }
                    .font(.caption.weight(.semibold)).padding(14)
            }
            .buttonStyle(.plain)
        }
        .frame(width: width, height: height)
        .background(Palette.surface)
        .foregroundStyle(Palette.text)
        .preferredColorScheme(.dark)
    }

    private func sessionRow(_ agent: CompanionAgent) -> some View {
        let usage = store.usage?.session(for: agent)
        return Button { store.openSession(agent.id) } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("\(agent.name) · \(agent.status.label)")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(agent.status.isAttention ? Palette.accent : Palette.text)
                    Spacer(minLength: 4)
                    Text("Open Session →").font(.caption).fixedSize()
                }
                Text("\(agent.repoName) · \(agent.sessionName)").font(.subheadline.weight(.semibold)).lineLimit(1)
                Text(agent.task).font(.caption).foregroundStyle(Palette.secondary).lineLimit(2)
                Text("Updated \(relativeTime(agent.updatedAt))").font(.caption2).foregroundStyle(Palette.secondary)
                if let usage {
                    Text("\(usage.modelLabel) · \(usage.totalTokens.formatted()) tokens all time")
                        .font(.caption).lineLimit(1)
                    if usage.models.count > 1 {
                        Text(usage.models.joined(separator: ", "))
                            .font(.caption2).lineLimit(2).foregroundStyle(Palette.secondary)
                    }
                    Text(usage.costLabel).font(.caption2).foregroundStyle(Palette.secondary)
                } else {
                    Text("Usage unavailable").font(.caption).foregroundStyle(Palette.secondary)
                }
            }
            .rowSurface()
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(agent.name), \(agent.repoName), \(agent.sessionName), \(agent.status.label), \(agent.task), \(usage.map { "\($0.totalTokens) tokens all time, \($0.costLabel)" } ?? "usage unavailable"), open Session")
    }
}

private struct SectionTitle: View {
    let title: String
    let count: Int
    var body: some View {
        HStack { Text(title); Spacer(); Text("\(count)") }
            .font(.caption.weight(.bold)).foregroundStyle(Palette.secondary)
            .padding(.top, 6)
            .accessibilityAddTraits(.isHeader)
    }
}
private extension View {
    func rowSurface() -> some View {
        self.frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(Palette.card, in: RoundedRectangle(cornerRadius: 10))
            .contentShape(RoundedRectangle(cornerRadius: 10))
    }
}
private func relativeTime(_ value: String) -> String {
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let date = parser.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    guard let date else { return "recently" }
    let seconds = max(0, Int(Date().timeIntervalSince(date)))
    if seconds < 60 { return "just now" }
    if seconds < 3600 { return "\(seconds / 60)m ago" }
    if seconds < 86400 { return "\(seconds / 3600)h ago" }
    return "\(seconds / 86400)d ago"
}

struct CompanionSettingsView: View {
    @ObservedObject var store: CompanionStore
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("AgentDeck Companion").font(.headline)
            Text("Quiet alerts while AgentDeck is in the background").font(.caption).foregroundStyle(.secondary)
            Toggle("macOS notifications", isOn: Binding(
                get: { store.preferences.notificationsEnabled },
                set: { store.setNotificationsEnabled($0) }
            ))
            Spacer()
            HStack {
                Text(store.connected ? "Connected" : "Reconnecting").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Open AgentDeck") { store.openAllAgents() }
            }
        }
        .padding(22)
        .frame(width: 380, height: 190)
    }
}
