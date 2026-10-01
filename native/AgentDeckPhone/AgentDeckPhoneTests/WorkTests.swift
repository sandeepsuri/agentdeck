import XCTest
@testable import AgentDeckPhone

// Phone work: the Work list, Start work and steering a Session, against the
// stub Mac. The JSON mirrors src/server/phone-work.ts and the Mac's own
// conversation and interaction routes.

private let feedJSON = """
{"sessions":[
  {"id":"sess-1","name":"Fix flaky test","agent":"claude","origin":"managed","repoId":"/Users/me/app","repoName":"app",
   "status":"working","live":true,"startedAt":"2026-10-01T09:00:00.000Z","lastActivityAt":"2026-10-01T09:05:00.000Z","need":"session-approval"},
  {"id":"sess-2","name":"Docs sweep","agent":"codex","origin":"managed","repoName":"app","status":"exited","live":false,
   "startedAt":"2026-10-01T08:00:00.000Z","lastActivityAt":"2026-10-01T08:30:00.000Z","endedAt":"2026-10-01T08:30:00.000Z"}],
 "runs":[
  {"id":"run-1","objective":"Add CSV export","repoId":"/Users/me/ledger","repoName":"ledger","status":"completed","runtime":"codex",
   "submittedAt":"2026-10-01T07:00:00.000Z","updatedAt":"2026-10-01T07:40:00.000Z","attemptCount":1,"review":"ready_to_review"}],
 "needs":[
  {"id":"interaction:i1","kind":"session-approval","sessionId":"sess-1","title":"Fix flaky test","detail":"Bash: npm test","at":"2026-10-01T09:05:00.000Z"},
  {"id":"run-review:run-1:1","kind":"run-review","runId":"run-1","title":"Add CSV export","detail":"4 files changed","at":"2026-10-01T07:40:00.000Z"}]}
"""

private let personalEmpty: (URLRequest) -> (Int, String)? = { request in
    switch request.url!.path {
    case "/api/personal/grants", "/api/personal/tasks": return (200, "[]")
    case "/api/phone/work": return (200, feedJSON)
    default: return nil
    }
}

final class WorkTests: XCTestCase {
    private var client: CompanionClient!

    override func setUp() {
        StubMac.handler = nil
        StubMac.requests = []
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubMac.self]
        client = CompanionClient(base: URL(string: "http://mac.tailnet.ts.net:4040")!, credential: "phone-credential", session: URLSession(configuration: configuration))
    }

    private func body(_ request: URLRequest?) throws -> [String: Any] {
        let data = try XCTUnwrap(request?.httpBody)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testDecodesTheWorkListWithWhatIsWaiting() throws {
        let feed = try JSONDecoder().decode(WorkFeed.self, from: Data(feedJSON.utf8))
        XCTAssertEqual(feed.sessions.first?.statusLabel, "Approve")
        XCTAssertEqual(feed.sessions.first?.tone, .waiting)
        XCTAssertEqual(feed.sessions.last?.statusLabel, "Ended")
        XCTAssertEqual(feed.runs.first?.statusLabel, "Ready to review")
        XCTAssertEqual(feed.runs.first?.tone, .review)
        XCTAssertEqual(feed.needs.map(\.label), ["Approve", "Ready to review"])
    }

    @MainActor func testCountsCodingWorkInNeedsYouAndForgetsItWhileTheMacIsAway() async throws {
        let model = CompanionModel(client: client) {}
        StubMac.handler = personalEmpty
        await model.refresh()
        XCTAssertEqual(model.link, .live)
        XCTAssertEqual(model.needsCount, 2)
        XCTAssertEqual(model.work.sessions.count, 2)

        StubMac.handler = nil
        await model.refresh()
        XCTAssertEqual(model.link, .unavailable)
        XCTAssertNil(model.work.feed)
        XCTAssertEqual(model.needsCount, 0)
    }

    @MainActor func testAnOlderMacWithoutPhoneWorkStillShowsTasks() async throws {
        let model = CompanionModel(client: client) {}
        StubMac.handler = { request in
            request.url!.path == "/api/phone/work" ? (404, #"{"error":"Route GET:/api/phone/work not found"}"#) : (200, "[]")
        }
        await model.refresh()
        XCTAssertEqual(model.link, .live)
        XCTAssertNil(model.work.feed)
    }

    @MainActor func testStartsQuickWorkAndOpensIt() async throws {
        let work = WorkModel(client: client) { _ in XCTFail("unexpected failure") }
        StubMac.handler = { request in
            request.url!.path == "/api/phone/sessions" ? (201, #"{"id":"sess-new"}"#) : (200, feedJSON)
        }
        let started = await work.startQuick(StartQuick(repositoryId: "/Users/me/app", task: "Fix it", agent: "auto",
                                                       permissionMode: "acceptEdits", branch: nil, createBranch: false))
        XCTAssertTrue(started)
        XCTAssertEqual(work.path, [.session("sess-new")])
        let sent = try body(StubMac.requests.first { $0.url!.path == "/api/phone/sessions" })
        XCTAssertEqual(sent["repositoryId"] as? String, "/Users/me/app")
        XCTAssertEqual(sent["permissionMode"] as? String, "acceptEdits")
        XCTAssertNil(sent["env"])
    }

    @MainActor func testShowsTheMacsRefusalWhenStructuredWorkCannotStart() async throws {
        let work = WorkModel(client: client) { _ in XCTFail("unexpected failure") }
        StubMac.handler = { _ in (409, #"{"error":"Set app's checks on the Mac first (Start work › Structured).","code":"checks-missing"}"#) }
        let started = await work.startStructured(StartStructured(repositoryId: "/Users/me/app", objective: "Add export", acceptanceCriteria: ["Exports"],
                                                                 agent: "auto", wallClockMinutes: 60, delivery: "apply-to-repository", baseReference: nil))
        XCTAssertFalse(started)
        XCTAssertEqual(work.notice, "Set app's checks on the Mac first (Start work › Structured).")
        XCTAssertTrue(work.path.isEmpty)
    }

    @MainActor func testSteersASessionThroughTheMacsOwnRoutes() async throws {
        let work = WorkModel(client: client) { _ in XCTFail("unexpected failure") }
        StubMac.handler = { _ in (200, #"{"ok":true}"#) }

        let sentKeys = await work.keys(["Esc"], to: "sess-1")
        XCTAssertTrue(sentKeys)
        XCTAssertEqual(StubMac.requests.last?.url?.path, "/api/phone/sessions/sess-1/keys")
        XCTAssertEqual(try body(StubMac.requests.last)["keys"] as? [String], ["Esc"])

        let sentText = await work.send("ship it", to: "sess-1")
        XCTAssertTrue(sentText)
        XCTAssertEqual(StubMac.requests.last?.url?.path, "/api/sessions/sess-1/send")

        let approval = try JSONDecoder().decode(Interaction.self, from: Data("""
        {"id":"i1","kind":"approval","question":"Bash","choices":[],"allowsFreeText":false,"requestedAt":"2026-10-01T09:05:00.000Z","status":"pending","canRespond":true}
        """.utf8))
        let decided = await work.decide(approval, approve: true, in: "sess-1")
        XCTAssertTrue(decided)
        XCTAssertEqual(StubMac.requests.last?.url?.path, "/api/sessions/sess-1/interactions/i1/respond")
        XCTAssertEqual(try body(StubMac.requests.last)["decision"] as? String, "approve")

        let question = try JSONDecoder().decode(OpenQuestion.self, from: Data("""
        {"id":"toolu_1","delivery":"menu","questions":[{"question":"Pick","multiSelect":false,"options":[{"label":"A"},{"label":"B"}]}],"canAnswer":true}
        """.utf8))
        let answered = await work.answer(question, with: [QuestionAnswer(selected: [1], other: nil)], in: "sess-1")
        XCTAssertTrue(answered)
        let answer = try body(StubMac.requests.last)
        XCTAssertEqual(answer["questionId"] as? String, "toolu_1")
        XCTAssertEqual((answer["answers"] as? [[String: Any]])?.first?["selected"] as? [Int], [1])
    }

    @MainActor func testFetchesAnImageTheAgentLookedAtOnceAndShowsTheMacsRefusal() async throws {
        let conversation = try JSONDecoder().decode(Conversation.self, from: Data(#"""
        {"found":true,"turns":[{"id":"img-3-0","role":"image","text":"login-failed.png","ts":"2026-10-01T09:05:00.000Z",
          "image":{"id":"img-3-0","mediaType":"image/png"}}]}
        """#.utf8))
        XCTAssertEqual(conversation.turns.first?.image, TurnImage(id: "img-3-0", mediaType: "image/png"))

        let work = WorkModel(client: client) { _ in XCTFail("unexpected failure") }
        StubMac.handler = { request in
            switch request.url!.path {
            case "/api/sessions/sess-1/images/img-3-0": return (200, #"{"mediaType":"image/png","data":"iVBORw0KGgo="}"#)
            case "/api/sessions/sess-1/images/img-4-0": return (413, #"{"error":"This image is too large to show here."}"#)
            default: return nil
            }
        }
        let first = try await work.image("img-3-0", in: "sess-1")
        let again = try await work.image("img-3-0", in: "sess-1")
        XCTAssertEqual(first, Data(base64Encoded: "iVBORw0KGgo="))
        XCTAssertEqual(again, first)
        XCTAssertEqual(StubMac.requests.filter { $0.url?.path == "/api/sessions/sess-1/images/img-3-0" }.count, 1)

        do {
            _ = try await work.image("img-4-0", in: "sess-1")
            XCTFail("expected the Mac's refusal")
        } catch {
            XCTAssertEqual(Work.imageFailure(error), "This image is too large to show here.")
        }
    }

    @MainActor func testFollowsTheTerminalTextByLongPoll() async throws {
        let work = WorkModel(client: client) { _ in }
        let follower = SessionFollower(sessionId: "sess-1", work: work)
        StubMac.handler = { request in
            request.url!.path == "/api/phone/sessions/sess-1/screen" ? (200, #"{"seq":3,"text":"❯ npm test","live":false,"available":true}"#) : nil
        }
        follower.watchTerminal()
        for _ in 0..<50 where follower.screen == nil { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertEqual(follower.screen?.text, "❯ npm test")
        XCTAssertEqual(StubMac.requests.first?.url?.query, "after=-1&wait=1500")
        follower.stop()
    }
}
