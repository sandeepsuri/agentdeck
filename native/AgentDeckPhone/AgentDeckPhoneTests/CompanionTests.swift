import XCTest
@testable import AgentDeckPhone

/** Answers every request from a script, or fails it as the network would. */
final class StubMac: URLProtocol {
    static var handler: ((URLRequest) -> (Int, String)?)?
    static var requests: [URLRequest] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var recorded = request
        if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
            recorded.httpBody = data
        }
        StubMac.requests.append(recorded)
        guard let (status, body) = StubMac.handler?(request) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["content-type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private let proposalJSON = """
{"id":"task-1","kind":"pdf-filing-proposal","title":"Propose filing for 1 PDF in Statements","status":"completed",
 "workspace":"owner","policyVersion":"personal-files/4","grant":{"id":"grant-1","name":"Statements","revoked":false},
 "files":["january.pdf"],"submittedAt":"2026-09-28T10:00:00.000Z","updatedAt":"2026-09-28T10:01:00.000Z",
 "submittedBy":{"displayName":"Sam","device":"Sam’s iPhone"},"attempts":[],
 "activity":[{"sequence":1,"at":"2026-09-28T10:00:00.000Z","kind":"submitted","message":"Submitted."}],
 "result":{"kind":"pdf-filing-proposal","attemptId":"a1","completedAt":"2026-09-28T10:01:00.000Z","planDigest":"abc123def4567890",
  "provider":{"runtime":"claude","cliVersion":"2.1.0","confinement":"macos-seatbelt"},
  "entries":[{"source":"january.pdf","sourceSha256":"x","newName":"January.pdf","destination":"Bills","target":"Bills/January.pdf",
   "warnings":[{"kind":"overwrite","message":"Bills/January.pdf already exists."}],"existingTargetSha256":"y"}],
  "unplanned":[],"skipped":[]}}
"""

private func task(_ json: String = proposalJSON) throws -> PersonalTask {
    try JSONDecoder().decode(PersonalTask.self, from: Data(json.utf8))
}

final class CompanionTests: XCTestCase {
    private var client: CompanionClient!

    override func setUp() {
        StubMac.handler = nil
        StubMac.requests = []
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubMac.self]
        client = CompanionClient(base: URL(string: "http://mac.tailnet.ts.net:4040")!, credential: "phone-credential", session: URLSession(configuration: configuration))
    }

    func testDecodesTheMacsProposalProjection() throws {
        let proposal = try task()
        XCTAssertTrue(proposal.result?.isProposal == true)
        XCTAssertEqual(proposal.result?.planDigest, "abc123def4567890")
        XCTAssertEqual(proposal.result?.entries?.first?.replacesFile, true)
        XCTAssertEqual(proposal.statusLabel, "Ready to review")
        XCTAssertFalse(proposal.unsettled)
    }

    func testNeedsYouPutsDecisionsBeforeProblemsAndDropsSettledWork() throws {
        let decision = try task()
        let failed = try task(proposalJSON
            .replacingOccurrences(of: "\"id\":\"task-1\"", with: "\"id\":\"task-2\"")
            .replacingOccurrences(of: "\"status\":\"completed\"", with: "\"status\":\"failed\",\"failure\":\"The folder is gone.\"")
            .replacingOccurrences(of: "2026-09-28T10:01:00.000Z\",\n \"submittedBy", with: "2026-09-28T09:00:00.000Z\",\n \"submittedBy"))
        let filed = try task(proposalJSON
            .replacingOccurrences(of: "\"id\":\"task-1\"", with: "\"id\":\"task-3\"")
            .replacingOccurrences(of: "\"activity\":", with: """
            "filing":{"state":"finished","planDigest":"abc","approvedBy":{"displayName":"Sam","device":"Phone"},"approvedAt":"2026-09-28T10:02:00.000Z",
             "expiresAt":"2026-09-28T10:12:00.000Z","receipts":[{"sequence":1,"source":"january.pdf","target":"Bills/January.pdf","overwrite":false,"state":"moved","updatedAt":"2026-09-28T10:02:00.000Z"}]},"activity":
            """))
        let needs = Need.from([failed, filed, decision])
        XCTAssertEqual(needs.map(\.taskId), ["task-1", "task-2"])
        XCTAssertEqual(needs.map(\.kind), [.decision, .problem])
        XCTAssertEqual(needs.last?.reason, "The folder is gone.")
    }

    func testTellsAnUnreachableMacFromARevokedPhoneFromARefusal() async throws {
        do { let _: [FolderGrant] = try await client.get("api/personal/grants"); XCTFail("expected a failure") }
        catch { XCTAssertEqual(error as? CompanionFailure, .unavailable) }

        StubMac.handler = { request in
            request.url!.path == "/api/connection" ? (200, #"{"kind":"remote","capabilities":[]}"#) : (403, #"{"error":"a valid tailnet token is required"}"#)
        }
        do { let _: [FolderGrant] = try await client.get("api/personal/grants"); XCTFail("expected a failure") }
        catch { XCTAssertEqual(error as? CompanionFailure, .revoked) }

        StubMac.handler = { _ in (409, #"{"error":"The plan changed. Review it again.","code":"stale-plan"}"#) }
        do { let _: PersonalTask = try await client.post("api/personal/tasks/task-1/filing/approve", ApproveFiling(planDigest: "old", overwrite: [])); XCTFail("expected a failure") }
        catch { XCTAssertEqual(error as? CompanionFailure, .refused("The plan changed. Review it again.")) }
        XCTAssertEqual(StubMac.requests.last?.value(forHTTPHeaderField: "x-agentdeck-token"), "phone-credential")

        // A Mac that answers with an error is up: it refuses, it is not unavailable.
        StubMac.handler = { _ in (500, #"{"error":"Internal Server Error"}"#) }
        do { let _: [FolderGrant] = try await client.get("api/personal/grants"); XCTFail("expected a failure") }
        catch { XCTAssertEqual(error as? CompanionFailure, .refused("Internal Server Error")) }
    }

    @MainActor func testShowsNothingAsLiveWhileTheMacIsAwayAndReloadsItAfter() async throws {
        let model = CompanionModel(client: client) {}
        StubMac.handler = { request in request.url!.path == "/api/personal/grants" ? (200, "[]") : (200, "[\(proposalJSON)]") }
        await model.refresh()
        XCTAssertEqual(model.link, .live)
        XCTAssertEqual(model.needs.count, 1)

        StubMac.handler = nil
        await model.refresh()
        XCTAssertEqual(model.link, .unavailable)
        XCTAssertTrue(model.tasks.isEmpty)
        XCTAssertTrue(model.needs.isEmpty)

        StubMac.handler = { request in request.url!.path == "/api/personal/grants" ? (200, "[]") : (200, "[\(proposalJSON)]") }
        await model.refresh()
        XCTAssertEqual(model.link, .live)
        XCTAssertEqual(model.tasks.first?.id, "task-1")
    }

    @MainActor func testApprovesTheExactPlanShownWithOnlyTheChosenReplacements() async throws {
        let model = CompanionModel(client: client) {}
        StubMac.handler = { _ in (200, proposalJSON) }
        let approved = await model.approve(try task(), replacing: ["january.pdf"])
        XCTAssertTrue(approved)
        let body = try XCTUnwrap(StubMac.requests.last?.httpBody)
        let sent = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        XCTAssertEqual(sent?["planDigest"] as? String, "abc123def4567890")
        XCTAssertEqual(sent?["overwrite"] as? [String], ["january.pdf"])
    }

    @MainActor func testResendsAFilingRetryLostToADroppedConnectionWithTheSameKey() async throws {
        var revoked = false
        let model = CompanionModel(client: client) { revoked = true }
        let proposal = try task()
        StubMac.handler = nil
        let lost = await model.filing(.retry, proposal)
        XCTAssertFalse(lost)
        StubMac.handler = { _ in (200, proposalJSON) }
        let sent = await model.filing(.retry, proposal)
        XCTAssertTrue(sent)
        let keys = try StubMac.requests.map { request -> String in
            let body = try JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [String: String]
            return try XCTUnwrap(body?["idempotencyKey"])
        }
        XCTAssertEqual(keys.count, 2)
        XCTAssertEqual(keys[0], keys[1])
        let _ = await model.filing(.retry, proposal)
        XCTAssertNotEqual(StubMac.requests.last.flatMap { String(data: $0.httpBody ?? Data(), encoding: .utf8) }?.contains(keys[0]), true)
        XCTAssertFalse(revoked)
    }
}
