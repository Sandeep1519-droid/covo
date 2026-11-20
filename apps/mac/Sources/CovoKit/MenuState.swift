import Foundation

/// What the menu bar icon shows (Phase 3 M4): idle, working, paused, a count of things waiting for
/// you, or that Covo's service can't be reached.
public enum MenuState: Equatable, Sendable {
    case offline
    case idle
    case working
    case paused
    case waiting(Int)

    public static func from(_ s: Summary?) -> MenuState {
        guard let s else { return .offline }
        if !s.waiting.isEmpty { return .waiting(s.waiting.count) }
        if s.paused { return .paused }
        if !s.running.isEmpty || s.queued > 0 { return .working }
        return .idle
    }

    /// For VoiceOver and the icon's tooltip.
    public var label: String {
        switch self {
        case .offline: "Covo isn't running"
        case .idle: "Covo: nothing running"
        case .working: "Covo: working"
        case .paused: "Covo: all bots paused"
        case let .waiting(n): "Covo: \(n) need\(n == 1 ? "s" : "") you"
        }
    }
}

/// Decides which waiting items deserve a notification: only ones that are new since last time, and
/// none for what was already waiting when the app started (you'd see those in the menu bar).
public struct NotifyPlanner: Sendable {
    private var seen: Set<String> = []
    private var started = false

    public init() {}

    public mutating func newItems(in s: Summary) -> [Summary.Waiting] {
        let ids = Set(s.waiting.map(\.id))
        defer {
            seen = ids
            started = true
        }
        guard started else { return [] }
        return s.waiting.filter { !seen.contains($0.id) }
    }
}

/// Prints what the app does when COVO_DEBUG is set (run the binary from Terminal to see it).
public func debugLog(_ message: @autoclosure () -> String) {
    guard ProcessInfo.processInfo.environment["COVO_DEBUG"] != nil else { return }
    FileHandle.standardError.write(Data("covo-mac: \(message())\n".utf8))
}
