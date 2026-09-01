import AppKit
import SwiftUI

private enum ADPalette {
    static let surface = Color.black
    static let text = Color(red: 0.957, green: 0.961, blue: 0.969)
    static let secondary = Color.white.opacity(0.48)
    static let tertiary = Color.white.opacity(0.32)
    static let hairline = Color.white.opacity(0.07)
    static let action = Color(red: 0.94, green: 0.63, blue: 0.20)
    static let waiting = Color(red: 0.84, green: 0.72, blue: 0.29)
    static let reply = Color(red: 0.31, green: 0.61, blue: 1.00)
    static let working = Color(red: 0.29, green: 0.82, blue: 0.51)
    static let starting = Color(red: 0.61, green: 0.46, blue: 0.96)
    static let offline = Color(red: 0.49, green: 0.52, blue: 0.56)

    static func accent(_ status: NotchStatus) -> Color {
        switch status {
        case .action: return action
        case .waiting: return waiting
        case .reply: return reply
        case .working: return working
        case .starting: return starting
        case .offline: return offline
        }
    }
}

private let morph = Animation.timingCurve(0.34, 1.15, 0.4, 1, duration: 0.42)

struct NotchRootView: View {
    @ObservedObject var store: CompanionStore

    var body: some View {
        VStack(spacing: 0) {
            CompactFace(store: store, menuMode: false)
            if store.isExpanded {
                DashboardPanel(store: store)
                    .frame(height: store.bodyHeight)
                    .transition(.opacity.animation(.easeIn(duration: 0.30).delay(0.06)))
            }
        }
        .frame(
            width: store.isExpanded ? NotchGeometry.expandedWidth : NotchGeometry.compactWidth,
            height: NotchGeometry.compactHeight + (store.isExpanded ? store.bodyHeight : 0),
            alignment: .top
        )
        .background(ADPalette.surface)
        .clipShape(UnevenRoundedRectangle(
            topLeadingRadius: 0,
            bottomLeadingRadius: 20,
            bottomTrailingRadius: 20,
            topTrailingRadius: 0
        ))
        .overlay {
            UnevenRoundedRectangle(
                topLeadingRadius: 0,
                bottomLeadingRadius: 20,
                bottomTrailingRadius: 20,
                topTrailingRadius: 0
            )
            .stroke(store.attentionGlow ? (store.priorityAgent.map { ADPalette.accent($0.status) } ?? ADPalette.reply) : .clear, lineWidth: 1)
            .shadow(
                color: store.attentionGlow ? (store.priorityAgent.map { ADPalette.accent($0.status) } ?? ADPalette.reply).opacity(0.75) : .clear,
                radius: store.attentionGlow ? 13 : 0
            )
            .animation(.easeInOut(duration: 0.65).repeatCount(3, autoreverses: true), value: store.attentionGlow)
        }
        .contentShape(Rectangle())
        .onHover { store.setHovered($0) }
        .animation(morph, value: store.isExpanded)
        .preferredColorScheme(.dark)
    }
}

struct MenuBarPillView: View {
    @ObservedObject var store: CompanionStore

    var body: some View {
        CompactFace(store: store, menuMode: true)
            .frame(width: NotchGeometry.menuWidth, height: NotchGeometry.menuHeight)
            .background(Color.black.opacity(0.94))
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.white.opacity(0.12), lineWidth: 0.5))
            .shadow(color: Color.black.opacity(0.35), radius: 7, y: 3)
            .onHover { store.setHovered($0) }
            .onTapGesture { store.togglePinned() }
            .preferredColorScheme(.dark)
    }
}

struct DetachedDashboardView: View {
    @ObservedObject var store: CompanionStore

    var body: some View {
        DashboardPanel(store: store)
            .frame(width: NotchGeometry.expandedWidth, height: store.bodyHeight)
            .background(ADPalette.surface)
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 20).stroke(Color.white.opacity(0.10), lineWidth: 0.5))
            .shadow(color: Color.black.opacity(0.45), radius: 22, y: 10)
            .onHover { store.setHovered($0) }
            .preferredColorScheme(.dark)
    }
}

private struct CompactFace: View {
    @ObservedObject var store: CompanionStore
    let menuMode: Bool

    var body: some View {
        ZStack {
            HStack(spacing: 10) {
                HStack(spacing: 8) {
                    CompactStatusDot(status: store.priorityAgent?.status ?? .offline)
                    Text(store.priorityAgent?.name ?? (store.connected ? "AgentDeck" : "Offline"))
                        .font(.system(size: menuMode ? 11.5 : 12.5, weight: .semibold))
                        .foregroundStyle(Color.white)
                        .lineLimit(1)
                    if !menuMode, let repo = store.priorityAgent?.repoName {
                        Text(repo)
                            .font(.system(size: 12.5))
                            .foregroundStyle(Color.white.opacity(0.40))
                            .lineLimit(1)
                    }
                }
                .layoutPriority(1)

                Spacer(minLength: menuMode ? 4 : 26)

                HStack(spacing: 10) {
                    if !menuMode {
                        Text(store.priorityAgent?.status.label ?? "OFFLINE")
                            .font(.system(size: 10, weight: .bold))
                            .tracking(0.3)
                            .foregroundStyle(ADPalette.accent(store.priorityAgent?.status ?? .offline))
                            .lineLimit(1)
                    }
                    if store.otherRunningCount > 0 {
                        Text("+\(store.otherRunningCount)")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Color(red: 0.90, green: 0.91, blue: 0.93))
                            .padding(.horizontal, 8)
                            .frame(height: 21)
                            .background(Color.white.opacity(0.12))
                            .clipShape(Capsule())
                    }
                }
            }
            .padding(.horizontal, menuMode ? 12 : 18)

            if !menuMode {
                Circle()
                    .fill(Color(red: 0.039, green: 0.039, blue: 0.047))
                    .frame(width: 8, height: 8)
                    .overlay(Circle().stroke(Color.white.opacity(0.08), lineWidth: 1))
                    .shadow(color: Color.white.opacity(0.05), radius: 1)
            }
        }
        .frame(height: menuMode ? NotchGeometry.menuHeight : NotchGeometry.compactHeight)
        .background(Color.black)
        .contentShape(Rectangle())
        .onTapGesture {
            if !menuMode { store.togglePinned() }
        }
    }
}

private struct CompactStatusDot: View {
    let status: NotchStatus
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var breathing = false

    var body: some View {
        Circle()
            .fill(ADPalette.accent(status))
            .frame(width: 8, height: 8)
            .scaleEffect(reduceMotion || status == .offline ? 1 : (breathing ? 1 : 0.80))
            .opacity(reduceMotion || status == .offline ? 0.72 : (breathing ? 1 : 0.52))
            .shadow(color: ADPalette.accent(status).opacity(0.65), radius: 5)
            .onAppear {
                guard !reduceMotion && status != .offline else { return }
                withAnimation(.easeInOut(duration: 1.4).repeatForever(autoreverses: true)) {
                    breathing = true
                }
            }
    }
}

struct DashboardPanel: View {
    @ObservedObject var store: CompanionStore

    var body: some View {
        VStack(spacing: 0) {
            DashboardHeader(store: store)
            Rectangle().fill(ADPalette.hairline).frame(height: 0.5)
            if store.repoGroups.isEmpty && store.runAttention.isEmpty {
                EmptyAgentsView(connected: store.connected)
                    .frame(maxHeight: .infinity)
            } else {
                ScrollView {
                    VStack(spacing: 8) {
                        if !store.runAttention.isEmpty {
                            RunAttentionSection(store: store)
                        }
                        ForEach(store.repoGroups) { group in
                            RepoGroupView(store: store, group: group)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                }
            }
            DashboardFooter(store: store)
        }
        .background(Color.black)
    }
}

/// Ticket 07: managed Run attention — kept visually and structurally
/// distinct from RepoGroupView/AgentRow (Session attention) rather than
/// merged into the same list, so this addition can never regress how
/// Session attention renders (AC6).
private struct RunAttentionSection: View {
    @ObservedObject var store: CompanionStore

    var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: "checkmark.shield")
                    .font(.system(size: 12))
                Text("Run Attention")
                    .font(.system(size: 12.5, weight: .semibold))
                Spacer()
                Text("\(store.runAttention.count)")
                    .font(.system(size: 11, weight: .semibold))
                    .frame(minWidth: 20, minHeight: 20)
                    .background(Color.white.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }
            .foregroundStyle(ADPalette.waiting)
            .frame(height: 28)
            .padding(.horizontal, 4)

            ForEach(store.runAttention) { item in
                RunAttentionRow(store: store, item: item)
            }
        }
    }
}

private struct RunAttentionRow: View {
    @ObservedObject var store: CompanionStore
    let item: RunAttentionItem

    var body: some View {
        ZStack(alignment: .leading) {
            RoundedRectangle(cornerRadius: 12)
                .fill(ADPalette.waiting.opacity(0.07))
            RoundedRectangle(cornerRadius: 99)
                .fill(ADPalette.waiting)
                .frame(width: 3)
                .padding(.vertical, 8)

            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.objective)
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundStyle(ADPalette.text)
                        .lineLimit(1)
                    Text(item.reason)
                        .font(.system(size: 11))
                        .foregroundStyle(Color.white.opacity(0.48))
                        .lineLimit(2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .layoutPriority(1)

                Text(item.kind == .approval ? "APPROVAL" : "INPUT")
                    .font(.system(size: 9.5, weight: .bold))
                    .tracking(0.4)
                    .foregroundStyle(ADPalette.waiting)
                    .padding(.horizontal, 8)
                    .frame(height: 24)
                    .background(ADPalette.waiting.opacity(0.16))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                    .fixedSize()

                Button("Open Run") { store.openRun(item.runId) }
                    .buttonStyle(OpenSessionButtonStyle())
            }
            .padding(.leading, 16)
            .padding(.trailing, 14)
            .padding(.vertical, 9)
        }
        .frame(height: 56)
        .contentShape(RoundedRectangle(cornerRadius: 12))
        .onTapGesture { store.openRun(item.runId) }
    }
}

private struct DashboardHeader: View {
    @ObservedObject var store: CompanionStore

    var body: some View {
        HStack(spacing: 11) {
            ADLogo(size: 34)
            VStack(alignment: .leading, spacing: 2) {
                Text("AgentDeck")
                    .font(.system(size: 15.5, weight: .bold))
                    .foregroundStyle(Color.white)
                HStack(spacing: 6) {
                    Circle().fill(ADPalette.working).frame(width: 7, height: 7)
                    Text("\(store.agents.count) \(store.agents.count == 1 ? "Agent" : "Agents") Running")
                        .font(.system(size: 12))
                        .foregroundStyle(Color.white.opacity(0.50))
                }
            }
            Spacer()
            Button { store.showSettings() } label: {
                Image(systemName: "slider.horizontal.3")
            }
            .buttonStyle(HeaderIconButtonStyle())
            .help("Companion settings")
            Menu {
                Button("Open AgentDeck") { store.openAllAgents() }
                Button(store.preferences.notificationsEnabled ? "Disable Notifications" : "Enable Notifications") {
                    store.setNotificationsEnabled(!store.preferences.notificationsEnabled)
                }
                Divider()
                Button("Quit AgentDeck Companion") { NSApp.terminate(nil) }
            } label: {
                Image(systemName: "ellipsis")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .frame(width: 30, height: 30)
            .background(Color.white.opacity(0.06))
            .clipShape(RoundedRectangle(cornerRadius: 9))
            .help("More")
        }
        .padding(.horizontal, 12)
        .frame(height: 62)
    }
}

private struct HeaderIconButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(Color.white.opacity(0.65))
            .frame(width: 30, height: 30)
            .background(Color.white.opacity(configuration.isPressed ? 0.15 : 0.06))
            .clipShape(RoundedRectangle(cornerRadius: 9))
    }
}

private struct RepoGroupView: View {
    @ObservedObject var store: CompanionStore
    let group: RepoGroup

    var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: "display")
                    .font(.system(size: 12))
                Text(group.name)
                    .font(.system(size: 12.5, weight: .semibold))
                Spacer()
                Text("\(group.agents.count)")
                    .font(.system(size: 11, weight: .semibold))
                    .frame(minWidth: 20, minHeight: 20)
                    .background(Color.white.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }
            .foregroundStyle(Color.white.opacity(0.62))
            .frame(height: 28)
            .padding(.horizontal, 4)

            ForEach(group.agents) { agent in
                AgentRow(store: store, agent: agent)
            }
        }
    }
}

private struct AgentRow: View {
    @ObservedObject var store: CompanionStore
    let agent: CompanionAgent
    @State private var hovering = false

    private var accent: Color { ADPalette.accent(agent.status) }

    var body: some View {
        ZStack(alignment: .leading) {
            RoundedRectangle(cornerRadius: 12)
                .fill(rowBackground)
            RoundedRectangle(cornerRadius: 99)
                .fill(accent.opacity(agent.status == .offline ? 0.35 : 1))
                .frame(width: 3)
                .padding(.vertical, 10)

            HStack(spacing: 12) {
                StatusTile(status: agent.status)
                VStack(alignment: .leading, spacing: 4) {
                    Text(agent.name)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(ADPalette.text)
                        .lineLimit(1)
                    Text(agent.task)
                        .font(.system(size: 11.5))
                        .foregroundStyle(Color.white.opacity(0.48))
                        .lineLimit(2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .layoutPriority(1)

                AgentProgress(agent: agent)
                    .frame(width: 150)

                Text(agent.status.label)
                    .font(.system(size: 9.5, weight: .bold))
                    .tracking(0.4)
                    .foregroundStyle(accent)
                    .padding(.horizontal, 8)
                    .frame(height: 24)
                    .background(accent.opacity(0.16))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                    .fixedSize()

                Button("Open Session") { store.openSession(agent.id) }
                    .buttonStyle(OpenSessionButtonStyle())
            }
            .padding(.leading, 16)
            .padding(.trailing, 14)
            .padding(.vertical, 11)

            if agent.status.showsCornerAlert {
                Circle()
                    .fill(accent)
                    .frame(width: 7, height: 7)
                    .shadow(color: accent.opacity(0.85), radius: 5)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                    .padding(.top, 9)
                    .padding(.trailing, 11)
                    .allowsHitTesting(false)
            }
        }
        .frame(height: 76)
        .contentShape(RoundedRectangle(cornerRadius: 12))
        .onTapGesture { store.openSession(agent.id) }
        .onHover { hovering = $0 }
    }

    private var rowBackground: Color {
        if hovering { return Color.white.opacity(0.085) }
        return agent.status.isAttention ? accent.opacity(0.07) : Color.white.opacity(0.028)
    }
}

private struct StatusTile: View {
    let status: NotchStatus
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var spinning = false
    @State private var pulsing = false

    var body: some View {
        ZStack {
            Circle()
                .fill(ADPalette.accent(status).opacity(status == .offline ? 0.04 : 0.08))
            Circle()
                .stroke(ADPalette.accent(status).opacity(0.28), lineWidth: 1.5)
            if status == .working || status == .starting {
                Circle()
                    .trim(from: 0.06, to: 0.33)
                    .stroke(ADPalette.accent(status), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                    .rotationEffect(.degrees(spinning ? 360 : 0))
            }
            Circle()
                .fill(ADPalette.accent(status))
                .frame(width: 7, height: 7)
                .scaleEffect(pulsing ? 0.50 : 1)
                .opacity(pulsing ? 0.30 : (status == .offline ? 0.45 : 1))
        }
        .frame(width: 30, height: 30)
        .onAppear {
            if !reduceMotion && (status == .working || status == .starting) {
                withAnimation(.linear(duration: 1).repeatForever(autoreverses: false)) {
                    spinning = true
                }
            }
            if !reduceMotion && (status == .action || status == .waiting) {
                withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) {
                    pulsing = true
                }
            }
        }
    }
}

private struct AgentProgress: View {
    let agent: CompanionAgent

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 5) {
                Image(systemName: "arrow.triangle.branch")
                    .font(.system(size: 10))
                Text(agent.branch ?? "no branch")
                    .font(.system(size: 11.5, design: .monospaced))
                    .lineLimit(1)
            }
            .foregroundStyle(Color.white.opacity(0.50))

            HStack(spacing: 8) {
                if let progress = agent.progress {
                    DeterminateProgress(value: progress, status: agent.status)
                    Text("\(Int(progress.rounded()))%")
                        .font(.system(size: 11, design: .monospaced))
                        .monospacedDigit()
                        .foregroundStyle(Color.white.opacity(0.42))
                        .frame(width: 32, alignment: .trailing)
                } else {
                    IndeterminateProgress(status: agent.status)
                    Text("—")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Color.white.opacity(0.30))
                        .frame(width: 32, alignment: .trailing)
                }
            }
        }
    }
}

private struct DeterminateProgress: View {
    let value: Double
    let status: NotchStatus

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.09))
                Capsule()
                    .fill(ADPalette.accent(status))
                    .frame(width: geometry.size.width * min(max(value, 0), 100) / 100)
            }
        }
        .frame(height: 5)
    }
}

private struct IndeterminateProgress: View {
    let status: NotchStatus
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phase: CGFloat = -1

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.09))
                if reduceMotion {
                    Capsule()
                        .fill(ADPalette.accent(status).opacity(0.55))
                        .frame(width: geometry.size.width * 0.34)
                } else {
                    Capsule()
                        .fill(LinearGradient(
                            colors: [
                                ADPalette.accent(status).opacity(0.18),
                                ADPalette.accent(status),
                                ADPalette.accent(status).opacity(0.18),
                            ],
                            startPoint: .leading,
                            endPoint: .trailing
                        ))
                        .frame(width: geometry.size.width * 0.42)
                        .offset(x: phase * geometry.size.width)
                        .onAppear {
                            withAnimation(.linear(duration: 1.6).repeatForever(autoreverses: false)) {
                                phase = 1.1
                            }
                        }
                }
            }
            .clipShape(Capsule())
        }
        .frame(height: 5)
    }
}

private struct OpenSessionButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 11.5, weight: .semibold))
            .foregroundStyle(Color(red: 0.90, green: 0.91, blue: 0.93))
            .padding(.horizontal, 12)
            .frame(height: 30)
            .frame(width: 108)
            .background(Color.white.opacity(configuration.isPressed ? 0.15 : 0.07))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.white.opacity(0.10), lineWidth: 0.5))
            .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

private struct DashboardFooter: View {
    @ObservedObject var store: CompanionStore

    var body: some View {
        Button { store.openAllAgents() } label: {
            HStack {
                Text("View All Agents")
                    .font(.system(size: 12.5))
                    .foregroundStyle(Color.white.opacity(0.55))
                Spacer()
                Text("⌘J")
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(Color.white.opacity(0.58))
                    .padding(.horizontal, 7)
                    .frame(height: 22)
                    .background(Color.white.opacity(0.07))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }
            .padding(.horizontal, 12)
            .frame(height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .top) { Rectangle().fill(ADPalette.hairline).frame(height: 0.5) }
        .keyboardShortcut("j", modifiers: .command)
    }
}

private struct EmptyAgentsView: View {
    let connected: Bool

    var body: some View {
        VStack(spacing: 9) {
            Image(systemName: connected ? "sparkles" : "bolt.slash")
                .font(.system(size: 20))
            Text(connected ? "No agents need the notch right now" : "Reconnecting to AgentDeck")
                .font(.system(size: 12.5, weight: .medium))
            Text(connected ? "Working and attention states appear here automatically." : "The companion will recover when the local server returns.")
                .font(.system(size: 11.5))
                .foregroundStyle(Color.white.opacity(0.42))
        }
        .foregroundStyle(Color.white.opacity(0.62))
        .multilineTextAlignment(.center)
        .padding(24)
    }
}

private struct ADLogo: View {
    let size: CGFloat

    var body: some View {
        Text("AD")
            .font(.system(size: size * 0.37, weight: .bold, design: .monospaced))
            .foregroundStyle(Color.white)
            .frame(width: size, height: size)
            .background(LinearGradient(
                colors: [
                    Color(red: 0.43, green: 0.56, blue: 1.0),
                    Color(red: 0.57, green: 0.39, blue: 0.88),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .shadow(color: Color(red: 0.47, green: 0.36, blue: 0.92).opacity(0.35), radius: 9, y: 4)
    }
}

struct CompanionSettingsView: View {
    @ObservedObject var store: CompanionStore

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 12) {
                ADLogo(size: 38)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Notch Companion").font(.system(size: 16, weight: .bold))
                    Text("Quiet alerts while AgentDeck is in the background")
                        .font(.system(size: 11.5))
                        .foregroundStyle(.secondary)
                }
            }
            Divider()
            Toggle("macOS notifications", isOn: Binding(
                get: { store.preferences.notificationsEnabled },
                set: { store.setNotificationsEnabled($0) }
            ))
            Toggle("Expand for important events", isOn: Binding(
                get: { store.preferences.attentionExpansionEnabled },
                set: { store.setAttentionExpansionEnabled($0) }
            ))
            Spacer()
            HStack {
                Text(store.connected ? "Connected to AgentDeck" : "Reconnecting…")
                    .font(.system(size: 11.5))
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Open AgentDeck") { store.openAllAgents() }
            }
        }
        .padding(22)
        .frame(width: 380, height: 230)
    }
}
