import Foundation

// Talks to Covo's service on 127.0.0.1 with the API token from ~/Covo/state/api-token (readable
// only by you). Requests say they come from the Mac app, so the activity log can tell.

/// Where Covo keeps its data, and where its service listens. COVO_HOME and COVO_PORT override them,
/// as on the command line.
public struct CovoHome: Sendable, Equatable {
    public let url: URL
    public let port: Int

    public init(env: [String: String] = ProcessInfo.processInfo.environment) {
        if let h = env["COVO_HOME"], !h.isEmpty {
            url = URL(fileURLWithPath: (h as NSString).expandingTildeInPath)
        } else {
            url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Covo")
        }
        port = Int(env["COVO_PORT"] ?? "") ?? 7420
    }

    public var tokenURL: URL { url.appendingPathComponent("state/api-token") }
    public var base: URL { URL(string: "http://127.0.0.1:\(port)")! }

    /// The API token. It's created by the service on first start.
    public func token() throws -> String {
        guard let raw = try? String(contentsOf: tokenURL, encoding: .utf8) else { throw CovoError.noToken }
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.count == 64, t.allSatisfy({ $0.isHexDigit }) else { throw CovoError.noToken }
        return t
    }

    /// A page of the app, signed in with a one-time code, opening at `route` (e.g. "#/needs-you").
    public func appURL(code: String, route: String) -> URL {
        var allowed = CharacterSet.urlFragmentAllowed
        allowed.remove(charactersIn: "&=#")
        let to = route.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
        return URL(string: "\(base.absoluteString)/ui/#code=\(code)&to=\(to)")!
    }
}

public enum CovoError: Error, Equatable, CustomStringConvertible {
    case noToken
    case offline
    case http(Int, String)

    public var description: String {
        switch self {
        case .noToken: "Covo isn't set up on this Mac yet. In Terminal, run: covo init, then covo service install"
        case .offline: "Covo's service isn't running."
        case let .http(code, message): "Covo answered \(code): \(message)"
        }
    }
}

public struct Health: Decodable, Sendable, Equatable {
    public let ok: Bool
    public let version: String
    public let pid: Int
    public let running: Int
    public let queued: Int
}

/// GET /api/summary (see packages/api: ApiSummary).
public struct Summary: Decodable, Sendable, Equatable {
    public struct Running: Decodable, Sendable, Equatable {
        public let runId: String
        public let botId: String
        public let botName: String
        public let goal: String
        public let startedAt: Double?
    }

    public struct Waiting: Decodable, Sendable, Equatable {
        public let id: String
        public let kind: String
        public let runId: String
        public let botId: String
        public let botName: String
        public let title: String
        public let payloadHash: String?
        public let at: Double

        public var isApproval: Bool { kind == "approval" }
        /// The app's screen for it.
        public var route: String { isApproval ? "#/bot/\(botId)" : "#/review/\(runId)" }
    }

    public let paused: Bool
    public let running: [Running]
    public let queued: Int
    public let waiting: [Waiting]
    public let todayUsd: Double
    public let dayLimitUsd: Double?
}

public final class CovoAPI: @unchecked Sendable {
    public let home: CovoHome
    private let session: URLSession

    public init(home: CovoHome = CovoHome()) {
        self.home = home
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 10
        config.httpCookieStorage = nil
        session = URLSession(configuration: config)
    }

    func request(_ method: String, _ path: String, body: [String: Any]? = nil) throws -> URLRequest {
        var r = URLRequest(url: home.base.appendingPathComponent("api").appendingPathComponent(path))
        r.httpMethod = method
        r.setValue("Bearer \(try home.token())", forHTTPHeaderField: "Authorization")
        r.setValue("mac-app", forHTTPHeaderField: "X-Covo-Client")
        if let body {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return r
    }

    private func send(_ r: URLRequest) async throws -> Data {
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: r)
        } catch {
            throw CovoError.offline
        }
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200 ..< 300).contains(code) else {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw CovoError.http(code, msg ?? "no details")
        }
        return data
    }

    public func health() async throws -> Health {
        try JSONDecoder().decode(Health.self, from: try await send(request("GET", "health")))
    }

    public func summary() async throws -> Summary {
        try JSONDecoder().decode(Summary.self, from: try await send(request("GET", "summary")))
    }

    /// A one-time code that signs a web view in (token only; it works once, for 2 minutes).
    public func pairCode() async throws -> String {
        let data = try await send(request("POST", "pair-code", body: [:]))
        guard let code = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["code"] as? String else {
            throw CovoError.http(500, "no code")
        }
        return code
    }

    /// Answers a spending pause. The hash ties the answer to the exact request you were shown.
    public func decide(approval id: String, approve: Bool, payloadHash: String) async throws {
        _ = try await send(request(
            "POST", "approvals/\(id)",
            body: ["decision": approve ? "approve" : "deny", "payloadHash": payloadHash]
        ))
    }

    public func setPaused(_ paused: Bool) async throws {
        _ = try await send(request("POST", "pause", body: ["paused": paused]))
    }

    /// Live updates (server-sent events). Calls `onEvent` for each message; returns when the
    /// connection ends, so the caller can reconnect.
    public func events(onEvent: @escaping @Sendable () -> Void) async throws {
        var r = try request("GET", "events")
        r.timeoutInterval = 60
        let (bytes, response) = try await session.bytes(for: r)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw CovoError.offline }
        for try await line in bytes.lines where line.hasPrefix("data:") {
            onEvent()
        }
    }
}
