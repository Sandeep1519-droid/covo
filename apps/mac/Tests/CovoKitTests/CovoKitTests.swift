import Foundation
import Testing
@testable import CovoKit

private func summary(waiting: [String] = [], running: Int = 0, queued: Int = 0, paused: Bool = false) throws -> Summary {
    let w = waiting.map {
        """
        {"id":"\($0)","kind":"approval","runId":"run_\($0)","botId":"bot_a","botName":"Assistant",
         "title":"Spend up to $0.50 more: tidy","payloadHash":"h","at":1}
        """
    }
    let r = (0 ..< running).map { _ in
        #"{"runId":"run_r","botId":"bot_a","botName":"Assistant","goal":"tidy","startedAt":null}"#
    }
    let json = """
    {"paused":\(paused),"running":[\(r.joined(separator: ","))],"queued":\(queued),
     "waiting":[\(w.joined(separator: ","))],"todayUsd":0.42,"dayLimitUsd":null}
    """
    return try JSONDecoder().decode(Summary.self, from: Data(json.utf8))
}

@Test func menuStateFollowsTheSummary() throws {
    #expect(MenuState.from(nil) == .offline)
    #expect(MenuState.from(try summary()) == .idle)
    #expect(MenuState.from(try summary(queued: 1)) == .working)
    #expect(MenuState.from(try summary(running: 1, paused: true)) == .paused)
    // What needs you wins over everything else.
    #expect(MenuState.from(try summary(waiting: ["a"], running: 1, paused: true)) == .waiting(1))
    #expect(MenuState.waiting(1).label == "Covo: 1 needs you")
    #expect(MenuState.waiting(2).label == "Covo: 2 need you")
}

@Test func notifiesOnlyAboutNewThings() throws {
    var p = NotifyPlanner()
    #expect(p.newItems(in: try summary(waiting: ["a"])).isEmpty) // already waiting at launch
    #expect(p.newItems(in: try summary(waiting: ["a", "b"])).map(\.id) == ["b"])
    #expect(p.newItems(in: try summary(waiting: ["b"])).isEmpty)
    #expect(p.newItems(in: try summary(waiting: ["a", "b"])).map(\.id) == ["a"]) // came back: new again
}

@Test func waitingItemsKnowTheirScreen() throws {
    let s = try summary(waiting: ["a"])
    #expect(s.waiting[0].route == "#/bot/bot_a")
    #expect(s.todayUsd == 0.42)
}

@Test func homeAndSignInLink() {
    let h = CovoHome(env: ["COVO_HOME": "/tmp/x", "COVO_PORT": "7421"])
    #expect(h.tokenURL.path == "/tmp/x/state/api-token")
    #expect(h.appURL(code: "abc-_1", route: "#/needs-you").absoluteString
        == "http://127.0.0.1:7421/ui/#code=abc-_1&to=%23/needs-you")
    #expect(CovoHome(env: [:]).port == 7420)
    #expect(throws: CovoError.noToken) { try h.token() }
}
