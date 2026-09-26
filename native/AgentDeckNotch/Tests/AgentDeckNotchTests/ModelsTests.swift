import XCTest
import SwiftUI
@testable import AgentDeckNotch

final class ModelsTests: XCTestCase {
    private func agent(_ id: String, status: CompanionStatus, provider: String = "claude") -> CompanionAgent {
        CompanionAgent(id: id, agent: provider, usageSessionId: "provider-\(id)", name: provider, sessionName: "Chat \(id)",
                       repo: "/repos/long-name", repoName: "long-name", task: "Current activity",
                       branch: nil, status: status, updatedAt: "2026-09-25T10:00:00Z", attentionId: nil)
    }

    func testDisplayDeduplicatesSessionsAndKeepsRunAttentionDistinct() {
        let reply = agent("one", status: .reply)
        let working = agent("two", status: .working)
        let run = RunAttentionItem(runId: "run", attentionId: "approval", objective: "Fix build",
                                   kind: .approval, reason: "Approve command", requestedAt: "2026-09-25T10:00:00Z")
        let display = CompanionDisplay(agents: [reply, reply, working], runs: [run], connected: true)
        XCTAssertEqual(display.actionableCount, 2)
        XCTAssertEqual(display.runningCount, 1)
        XCTAssertEqual(display.attention.map(\.id), ["one"])
        XCTAssertEqual(display.runs.map(\.runId), ["run"])
    }

    func testDisconnectedDisplayHasNoStaleWorkingClaims() {
        let display = CompanionDisplay(agents: [agent("one", status: .working)], runs: [], connected: false)
        XCTAssertEqual(display.runningCount, 0)
        XCTAssertTrue(display.progress.isEmpty)
    }

    func testUsageMatchesProviderAndSessionId() {
        let usage = CompanionUsage(month: TokenTotals(totalTokens: 42, costUsd: 1, unpricedTokens: 0, events: 1),
            sessions: [UsageSession(provider: "codex", sessionId: "provider-one", models: ["gpt-5"], totalTokens: 42, costUsd: 1, unpricedTokens: 0)], indexedAt: "2026-09-25")
        XCTAssertNil(usage.session(for: agent("one", status: .working)))
        XCTAssertEqual(usage.session(for: agent("one", status: .working, provider: "codex"))?.totalTokens, 42)
    }

    func testMultipleModelsAndPartialPricingAreExplicit() {
        let usage = UsageSession(provider: "claude", sessionId: "s", models: ["sonnet", "unknown"], totalTokens: 100,
                                 costUsd: 0.5, unpricedTokens: 20)
        XCTAssertEqual(usage.modelLabel, "Multiple models")
        XCTAssertTrue(usage.costLabel.contains("Partial API estimate"))
        XCTAssertEqual(CompanionStatus.waiting.label, "Input needed")
        XCTAssertEqual(CompanionStatus.reply.label, "New reply")
    }

    func testPopoverFitsVisibleScreen() {
        XCTAssertEqual(CompanionGeometry.popoverSize(in: CGRect(x: 0, y: 0, width: 320, height: 400)),
                       CGSize(width: 304, height: 384))
        XCTAssertEqual(CompanionGeometry.popoverSize(in: CGRect(x: 0, y: 0, width: 1200, height: 900)),
                       CGSize(width: CompanionGeometry.popoverWidth, height: CompanionGeometry.popoverHeight))
    }

    @MainActor
    func testPopoverAndMenuBarRenderAtFixedWidths() {
        let store = CompanionStore(port: 4040, initialAgents: [agent("one", status: .reply)])
        let menu = NSHostingView(rootView: MenuBarPillView(store: store))
        menu.frame = NSRect(x: 0, y: 0, width: CompanionGeometry.menuWidth, height: CompanionGeometry.menuHeight)
        menu.layoutSubtreeIfNeeded()
        XCTAssertEqual(menu.frame.width, CompanionGeometry.menuWidth)
        let popover = NSHostingView(rootView: DetachedDashboardView(store: store))
        popover.frame = NSRect(x: 0, y: 0, width: CompanionGeometry.popoverWidth, height: CompanionGeometry.popoverHeight)
        popover.layoutSubtreeIfNeeded()
        XCTAssertEqual(popover.frame.width, CompanionGeometry.popoverWidth)
    }
}
