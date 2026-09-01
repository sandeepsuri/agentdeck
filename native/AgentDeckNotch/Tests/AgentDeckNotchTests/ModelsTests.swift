import XCTest
import SwiftUI
@testable import AgentDeckNotch

final class ModelsTests: XCTestCase {
    private func agent(
        _ id: String,
        repo: String,
        status: NotchStatus,
        updatedAt: String = "2026-07-23T10:00:00Z",
        progress: Double? = nil
    ) -> CompanionAgent {
        CompanionAgent(
            id: id,
            agent: id.contains("claude") ? "claude" : "codex",
            name: id.contains("claude") ? "Claude Code" : "Codex",
            repo: "/repos/\(repo)",
            repoName: repo,
            task: "Task \(id)",
            branch: "feature/\(id)",
            progress: progress,
            status: status,
            updatedAt: updatedAt,
            attentionId: status.isAttention ? "attention-\(id)" : nil
        )
    }

    func testAgentsSortByNotchPriorityThenRecency() {
        let agents = [
            agent("working", repo: "web", status: .working),
            agent("reply", repo: "web", status: .reply),
            agent("action-old", repo: "api", status: .action, updatedAt: "2026-07-23T10:01:00Z"),
            agent("action-new", repo: "api", status: .action, updatedAt: "2026-07-23T10:02:00Z"),
            agent("starting", repo: "api", status: .starting),
        ]
        XCTAssertEqual(
            sortedCompanionAgents(agents).map(\.id),
            ["action-new", "action-old", "reply", "working", "starting"]
        )
    }

    func testAgentsGroupByRepoInPriorityOrder() {
        let groups = groupedCompanionAgents([
            agent("working", repo: "web", status: .working),
            agent("action", repo: "api", status: .action),
            agent("reply", repo: "web", status: .reply),
        ])
        XCTAssertEqual(groups.map(\.name), ["api", "web"])
        XCTAssertEqual(groups[1].agents.map(\.id), ["reply", "working"])
    }

    func testExpandedBodyHeightIsContentDrivenAndCapped() {
        XCTAssertEqual(NotchGeometry.bodyHeight(groups: 0, agents: 0), 180)
        XCTAssertLessThan(NotchGeometry.bodyHeight(groups: 2, agents: 6), 680)
        XCTAssertEqual(NotchGeometry.bodyHeight(groups: 8, agents: 30), 680)
    }

    func testExpansionAndRunningCountRules() {
        XCTAssertFalse(companionShouldExpand(hovered: false, pinned: false, attentionExpanded: false))
        XCTAssertTrue(companionShouldExpand(hovered: true, pinned: false, attentionExpanded: false))
        XCTAssertTrue(companionShouldExpand(hovered: false, pinned: true, attentionExpanded: false))
        XCTAssertTrue(companionShouldExpand(hovered: false, pinned: false, attentionExpanded: true))
        XCTAssertEqual(otherRunningAgentCount([
            agent("action", repo: "web", status: .action),
            agent("working", repo: "web", status: .working),
            agent("offline", repo: "web", status: .offline),
        ], hasPriorityAgent: true), 1)
    }

    func testCompanionWireModelSupportsOptionalProgress() throws {
        let encoded = try JSONEncoder().encode(agent("codex", repo: "web", status: .working, progress: 48.5))
        let decoded = try JSONDecoder().decode(CompanionAgent.self, from: encoded)
        XCTAssertEqual(decoded.progress, 48.5)
        XCTAssertEqual(decoded.status, .working)
    }

    func testAttentionWireValuesMatchServerContract() throws {
        XCTAssertEqual(try JSONEncoder().encode(AttentionKind.actionRequired), Data("\"action_required\"".utf8))
        XCTAssertEqual(
            try JSONDecoder().decode(AttentionKind.self, from: Data("\"response_required\"".utf8)),
            .responseRequired
        )
    }

    // Ticket 07: RunAttentionKind/RunAttentionItem must decode the exact
    // wire shape src/types.ts's RunAttentionItem and attention.ts's
    // deriveRunAttentionItems produce — 'approval'/'input' (unlike
    // AttentionKind's snake_case Session variants), and the full field set
    // GET /api/runs/attention and the companion_snapshot WS push both send.
    func testRunAttentionWireValuesMatchServerContract() throws {
        XCTAssertEqual(try JSONEncoder().encode(RunAttentionKind.approval), Data("\"approval\"".utf8))
        XCTAssertEqual(try JSONDecoder().decode(RunAttentionKind.self, from: Data("\"input\"".utf8)), .input)

        let json = """
        {
            "runId": "run-1",
            "attentionId": "attention-1",
            "objective": "Fix the flaky test",
            "kind": "approval",
            "reason": "Approve command: rm -rf node_modules",
            "requestedAt": "2026-09-01T00:00:00.000Z"
        }
        """
        let decoded = try JSONDecoder().decode(RunAttentionItem.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.runId, "run-1")
        XCTAssertEqual(decoded.attentionId, "attention-1")
        XCTAssertEqual(decoded.id, "attention-1")
        XCTAssertEqual(decoded.kind, .approval)
    }

    // AC6's regression guarantee made concrete: one CompanionSnapshot decode
    // call must produce BOTH Session attention and Run attention correctly
    // — this is the strict-decode failure mode a missing/mismatched field
    // would hit (CompanionStore.fetchSnapshot/receive both use `try?`,
    // silently dropping the *entire* snapshot, Session attention included,
    // on any decode error — see the class's own doc comments).
    func testCompanionSnapshotDecodesBothSessionAndRunAttentionTogether() throws {
        let json = """
        {
            "sessions": [],
            "attention": [{
                "id": "sess-1:action_required",
                "kind": "action_required",
                "sessionId": "sess-1",
                "agent": "claude",
                "sessionName": "example",
                "repo": "/repos/example",
                "repoName": "example",
                "occurredAt": "2026-09-01T00:00:00.000Z"
            }],
            "agents": [],
            "runAttention": [{
                "runId": "run-1",
                "attentionId": "attention-1",
                "objective": "Fix the flaky test",
                "kind": "input",
                "reason": "What framework should this use?",
                "requestedAt": "2026-09-01T00:00:00.000Z"
            }],
            "uiVisible": false
        }
        """
        let snapshot = try JSONDecoder().decode(CompanionSnapshot.self, from: Data(json.utf8))
        XCTAssertEqual(snapshot.attention.map(\.id), ["sess-1:action_required"])
        XCTAssertEqual(snapshot.runAttention.map(\.attentionId), ["attention-1"])
        XCTAssertEqual(snapshot.runAttention[0].kind, .input)
    }

    func testExpandedBodyHeightGrowsWithPendingRunAttention() {
        let withoutRunAttention = NotchGeometry.bodyHeight(groups: 1, agents: 2)
        let withRunAttention = NotchGeometry.bodyHeight(groups: 1, agents: 2, runAttentionCount: 2)
        XCTAssertGreaterThan(withRunAttention, withoutRunAttention)
        // The 2-argument form (every pre-ticket-07 call site) is unchanged.
        XCTAssertEqual(NotchGeometry.bodyHeight(groups: 0, agents: 0), 180)
    }

    @MainActor
    func testExpandedDashboardRendersAtTargetWidth() {
        let agents = [
            agent("action", repo: "agentdeck-web", status: .action, progress: 48),
            agent("claude-reply", repo: "agentdeck-web", status: .reply, progress: 90),
            agent("working", repo: "agentdeck-api", status: .working),
        ]
        let store = CompanionStore(port: 4040, initialAgents: agents)
        let host = NSHostingView(rootView:
            DetachedDashboardView(store: store)
                .frame(width: NotchGeometry.expandedWidth, height: store.bodyHeight)
        )
        host.frame = NSRect(
            x: 0, y: 0,
            width: NotchGeometry.expandedWidth,
            height: store.bodyHeight
        )
        host.layoutSubtreeIfNeeded()
        host.displayIfNeeded()
        let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds)
        if let bitmap { host.cacheDisplay(in: host.bounds, to: bitmap) }
        let image = NSImage(size: host.bounds.size)
        if let bitmap { image.addRepresentation(bitmap) }
        XCTAssertNotNil(bitmap)
        XCTAssertEqual(image.size.width, NotchGeometry.expandedWidth)
        if let path = ProcessInfo.processInfo.environment["AGENTDECK_RENDER_PATH"],
           let tiff = image.tiffRepresentation,
           let bitmap = NSBitmapImageRep(data: tiff),
           let png = bitmap.representation(using: .png, properties: [:]) {
            try? png.write(to: URL(fileURLWithPath: path))
        }
    }

    // Ticket 07 AC6: the same dashboard render this suite already exercised
    // for Session attention (testExpandedDashboardRendersAtTargetWidth,
    // unmodified above) still renders correctly with Run attention items
    // also present — proving the addition doesn't regress the existing
    // Session-attention render path rather than merely not crashing.
    @MainActor
    func testExpandedDashboardRendersRunAttentionAlongsideSessionAttention() {
        let agents = [
            agent("action", repo: "agentdeck-web", status: .action, progress: 48),
            agent("working", repo: "agentdeck-api", status: .working),
        ]
        let runAttention = [
            RunAttentionItem(
                runId: "run-1", attentionId: "attention-1", objective: "Fix the flaky test",
                kind: .approval, reason: "Approve command: rm -rf node_modules", requestedAt: "2026-09-01T00:00:00Z"
            ),
        ]
        let store = CompanionStore(port: 4040, initialAgents: agents, initialRunAttention: runAttention)
        XCTAssertEqual(store.agents.count, 2)
        XCTAssertEqual(store.runAttention.count, 1)
        let host = NSHostingView(rootView:
            DetachedDashboardView(store: store)
                .frame(width: NotchGeometry.expandedWidth, height: store.bodyHeight)
        )
        host.frame = NSRect(x: 0, y: 0, width: NotchGeometry.expandedWidth, height: store.bodyHeight)
        host.layoutSubtreeIfNeeded()
        host.displayIfNeeded()
        let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds)
        if let bitmap { host.cacheDisplay(in: host.bounds, to: bitmap) }
        XCTAssertNotNil(bitmap)
    }

    @MainActor
    func testCompactNotchRendersAtTargetSize() {
        let store = CompanionStore(port: 4040, initialAgents: [
            agent("action", repo: "agentdeck-web", status: .action),
            agent("working", repo: "agentdeck-api", status: .working),
        ])
        let host = NSHostingView(rootView: NotchRootView(store: store))
        host.frame = NSRect(
            x: 0, y: 0,
            width: NotchGeometry.compactWidth,
            height: NotchGeometry.compactHeight
        )
        host.layoutSubtreeIfNeeded()
        host.displayIfNeeded()
        let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds)
        if let bitmap { host.cacheDisplay(in: host.bounds, to: bitmap) }
        XCTAssertNotNil(bitmap)
        if let path = ProcessInfo.processInfo.environment["AGENTDECK_COMPACT_RENDER_PATH"],
           let bitmap,
           let png = bitmap.representation(using: .png, properties: [:]) {
            try? png.write(to: URL(fileURLWithPath: path))
        }
    }
}
