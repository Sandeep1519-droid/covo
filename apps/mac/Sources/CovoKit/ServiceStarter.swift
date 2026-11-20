import Foundation

/// Starts Covo's background service if it isn't running, using the login item `covo service install`
/// set up (launchd label com.covobot.covod). Without that, it can only explain what to do.
public enum ServiceStarter {
    public static let label = "com.covobot.covod"

    public static var plistURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(label).plist")
    }

    public static var isInstalled: Bool { FileManager.default.fileExists(atPath: plistURL.path) }

    /// Asks launchd to (re)start the service. Returns false if it isn't installed or launchctl failed.
    @discardableResult
    public static func kickstart() -> Bool {
        guard isInstalled else { return false }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        p.arguments = ["kickstart", "gui/\(getuid())/\(label)"]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do {
            try p.run()
            p.waitUntilExit()
            return p.terminationStatus == 0
        } catch {
            return false
        }
    }
}
