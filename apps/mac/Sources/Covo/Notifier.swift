import AppKit
import CovoKit
import UserNotifications

/// macOS notifications when something needs you. A spending pause can be answered from the
/// notification itself; anything else opens the right screen.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    var onAnswer: ((Summary.Waiting, Bool) -> Void)?
    var onOpen: ((String) -> Void)?
    /// Notifications need a real app bundle; a bare `swift run` binary has none.
    private var center: UNUserNotificationCenter? {
        Bundle.main.bundleIdentifier == nil ? nil : UNUserNotificationCenter.current()
    }

    private var items: [String: Summary.Waiting] = [:]

    func setUp() {
        guard let center else { return }
        center.delegate = self
        let allow = UNNotificationAction(identifier: "allow", title: "Allow", options: [])
        let stop = UNNotificationAction(identifier: "stop", title: "Stop", options: [.destructive])
        let review = UNNotificationAction(identifier: "open", title: "Review", options: [.foreground])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: "approval", actions: [allow, stop], intentIdentifiers: []),
            UNNotificationCategory(identifier: "changes", actions: [review], intentIdentifiers: []),
        ])
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    func post(_ item: Summary.Waiting) {
        guard let center else { return }
        items[item.id] = item
        let c = UNMutableNotificationContent()
        c.title = item.isApproval ? "\(item.botName) needs your OK" : "\(item.botName) has changes for you"
        c.body = item.title
        c.sound = .default
        c.categoryIdentifier = item.isApproval ? "approval" : "changes"
        c.userInfo = ["id": item.id]
        center.add(UNNotificationRequest(identifier: item.id, content: c, trigger: nil))
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let id = response.notification.request.content.userInfo["id"] as? String ?? ""
        let action = response.actionIdentifier
        await MainActor.run {
            guard let item = self.items[id] else { return }
            switch action {
            case "allow": self.onAnswer?(item, true)
            case "stop": self.onAnswer?(item, false)
            default: self.onOpen?(item.route)
            }
        }
    }
}
