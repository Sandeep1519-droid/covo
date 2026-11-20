import AppKit
import CovoKit
import SwiftUI
import WebKit

// Covo.app (Phase 3 M4): a menu bar icon with a panel, a window with the chat app, notifications,
// and it starts Covo's service when needed. The screens are the web app the service serves, shown
// with the system's own web engine (WKWebView), so the Mac app stays small.

@main
struct CovoApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        MenuBarExtra {
            PanelView(model: delegate.model)
        } label: {
            MenuLabel(model: delegate.model)
        }
        .menuBarExtraStyle(.window)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = CovoModel()

    func applicationDidFinishLaunching(_ note: Notification) {
        model.start()
        // Opened at login, it stays in the menu bar; opened by you, it shows its window.
        if !launchedAtLogin { model.showWindow() }
    }

    /// Clicking the Dock icon brings the window back.
    func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows: Bool) -> Bool {
        if !hasVisibleWindows { model.showWindow() }
        return true
    }

    /// Closing the window keeps Covo in the menu bar.
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }

    private var launchedAtLogin: Bool {
        let e = NSAppleEventManager.shared().currentAppleEvent
        return e?.eventID == kAEOpenApplication
            && e?.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
    }
}

/// The menu bar icon: the bot's face, a dot while working, closed eyes when paused, and how many
/// things need you.
struct MenuLabel: View {
    @ObservedObject var model: CovoModel

    var body: some View {
        HStack(spacing: 3) {
            Image(nsImage: MenuIcon.image(for: model.state))
            if case let .waiting(n) = model.state { Text("\(n)") }
        }
        .accessibilityLabel(model.state.label)
        .help(model.state.label)
    }
}

/// The menu bar panel (Figma X1): the web app's panel page, plus two Mac-only controls.
struct PanelView: View {
    @ObservedObject var model: CovoModel

    var body: some View {
        VStack(spacing: 0) {
            if let problem = model.problem, model.summary == nil {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Covo isn't running").font(.headline)
                    Text(problem).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Button("Try again") { model.retry() }
                }
                .padding(14)
                .frame(width: 340, alignment: .leading)
            } else {
                WebPanel(view: model.panel).frame(width: 340, height: model.panelHeight)
            }
            Divider()
            HStack {
                Toggle("Open at login", isOn: Binding(get: { model.openAtLogin }, set: { model.setOpenAtLogin($0) }))
                    .toggleStyle(.checkbox)
                Spacer()
                Button("Quit Covo") { NSApp.terminate(nil) }.buttonStyle(.borderless)
            }
            .font(.caption)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
        }
        .frame(width: 340)
    }
}

struct WebPanel: NSViewRepresentable {
    let view: WKWebView
    func makeNSView(context: Context) -> WKWebView { view }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
