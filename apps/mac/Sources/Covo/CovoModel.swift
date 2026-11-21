import AppKit
import CovoKit
import ServiceManagement
import WebKit

/// The app's state: what the service reports, the two web views (window and menu bar panel), and the
/// things the app does on its own (start the service, notify you).
@MainActor
final class CovoModel: ObservableObject {
    @Published private(set) var summary: Summary?
    @Published private(set) var state: MenuState = .offline
    /// Why the service can't be reached, in words for people.
    @Published private(set) var problem: String?
    @Published var panelHeight: CGFloat = 320
    @Published private(set) var openAtLogin = SMAppService.mainApp.status == .enabled

    let api = CovoAPI()
    let notifier = Notifier()
    private(set) lazy var panel: WKWebView = makeWebView(main: false)
    private var window: MainWindow?
    private var planner = NotifyPlanner()
    private var servicePid: Int?
    private var panelLoaded = false
    private var refreshing = false
    private var again = false

    func start() {
        notifier.onAnswer = { [weak self] item, approve in self?.answer(item, approve: approve) }
        notifier.onOpen = { [weak self] route in self?.showWindow(route: route) }
        notifier.setUp()
        Task {
            await ensureService()
            await refresh()
            listen()
        }
        // A slow safety net in case live updates drop.
        Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.refresh() }
        }
    }

    // MARK: The service

    /// Starts Covo's service if it isn't answering (M4: "it starts the service if it isn't running").
    func ensureService() async {
        if (try? await api.health()) != nil { return }
        guard ServiceStarter.isInstalled else {
            problem = "Covo's service isn't installed. In Terminal, run: covo service install"
            return
        }
        debugLog("service: not answering, starting it")
        ServiceStarter.kickstart()
        for _ in 0 ..< 20 {
            try? await Task.sleep(for: .milliseconds(300))
            if (try? await api.health()) != nil {
                problem = nil
                return
            }
        }
        problem = "Covo's service didn't start. In Terminal, run: covo service status"
    }

    func refresh() async {
        if refreshing {
            again = true
            return
        }
        refreshing = true
        defer { refreshing = false }
        repeat {
            again = false
            do {
                let h = try await api.health()
                let s = try await api.summary()
                problem = nil
                if servicePid != nil, servicePid != h.pid {
                    // The service restarted: its sign-in sessions are gone, so sign the views in again.
                    panelLoaded = false
                    window?.loaded = false
                }
                servicePid = h.pid
                summary = s
                let next = MenuState.from(s)
                if next != state { debugLog("menu bar: \(next.label)") }
                state = next
                for item in planner.newItems(in: s) {
                    debugLog("notify: \(item.botName): \(item.title)")
                    notifier.post(item)
                }
                if !panelLoaded { await loadPanel() }
            } catch {
                summary = nil
                if state != .offline { debugLog("menu bar: offline (\(error))") }
                state = .offline
                if problem == nil { problem = (error as? CovoError)?.description ?? "\(error)" }
            }
        } while again
    }

    private func listen() {
        let api = self.api
        Task { [weak self] in
            while true {
                do {
                    try await api.events { [weak self] in
                        Task { @MainActor [weak self] in await self?.refresh() }
                    }
                } catch {}
                // Lost the connection (the service restarted?): try to bring it back, then listen again.
                try? await Task.sleep(for: .seconds(2))
                guard let self else { return }
                await self.ensureService()
                await self.refresh()
            }
        }
    }

    // MARK: Web views

    func makeWebView(main: Bool) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // shared, so the window and the panel share one sign-in
        let bridge = Bridge(model: self)
        config.userContentController.add(bridge, name: "covo")
        let view: WKWebView = main ? MainWebView(frame: .zero, configuration: config) : WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = bridge
        view.uiDelegate = bridge
        bridge.view = view
        view.setValue(false, forKey: "drawsBackground")
        return view
    }

    private func loadPanel() async {
        guard let code = try? await api.pairCode() else { return }
        panel.load(URLRequest(url: api.home.appURL(code: code, route: "#/menubar")))
        panelLoaded = true
        debugLog("panel: signed in")
    }

    private var lastSignIn: [ObjectIdentifier: Date] = [:]

    /// A page lost its sign-in: get a fresh one-time code with the token and reload it at `route`.
    /// At most every 15 seconds per page, so a service that keeps refusing can't cause a loop.
    func signInAgain(_ view: WKWebView?, route: String) {
        guard let view else { return }
        let key = ObjectIdentifier(view)
        if let last = lastSignIn[key], Date().timeIntervalSince(last) < 15 { return }
        lastSignIn[key] = Date()
        Task {
            guard let code = try? await api.pairCode() else {
                await ensureService()
                return
            }
            view.load(URLRequest(url: api.home.appURL(code: code, route: route)))
            debugLog("signed in again at \(route)")
        }
    }

    /// Shows the main window at a screen of the app, signing it in if needed.
    func showWindow(route: String = "#/bot/") {
        let w = window ?? MainWindow(model: self)
        window = w
        NSApp.activate(ignoringOtherApps: true)
        w.showWindow(nil)
        w.window?.makeKeyAndOrderFront(nil)
        if w.loaded {
            w.webView.evaluateJavaScript("location.hash = \(jsString(route))")
        } else {
            Task {
                guard let code = try? await api.pairCode() else {
                    await ensureService()
                    return
                }
                w.webView.load(URLRequest(url: api.home.appURL(code: code, route: route)))
                w.loaded = true
                debugLog("window: signed in at \(route)")
            }
        }
    }

    private var themeChoice = "system"

    /// The theme you picked in Settings ("system", "light" or "dark"): the whole app follows it, so
    /// the translucent frame and the menu bar panel match the page. The other web view is told too.
    func applyTheme(_ choice: String, from source: WKWebView?) {
        guard ["system", "light", "dark"].contains(choice), choice != themeChoice else { return }
        themeChoice = choice
        NSApp.appearance = switch choice {
        case "light": NSAppearance(named: .aqua)
        case "dark": NSAppearance(named: .darkAqua)
        default: nil
        }
        for view in [panel, window?.webView].compactMap({ $0 }) where view !== source {
            view.evaluateJavaScript("window.covo && window.covo.setThemeChoice(\(jsString(choice)))")
        }
        debugLog("theme: \(choice)")
    }

    func setDragRegions(drag: [CGRect], keep: [CGRect]) {
        (window?.webView as? MainWebView)?.setDragRegions(drag: drag, keep: keep)
    }

    // MARK: Actions

    func answer(_ item: Summary.Waiting, approve: Bool) {
        guard let hash = item.payloadHash else { return showWindow(route: item.route) }
        Task {
            do {
                try await api.decide(approval: item.id, approve: approve, payloadHash: hash)
                debugLog("answered \(item.id): \(approve ? "allow" : "stop")")
            } catch {
                // It may have changed or expired: show it, so you can look again.
                showWindow(route: item.route)
            }
            await refresh()
        }
    }

    func setOpenAtLogin(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            problem = "macOS didn't allow it: \(error.localizedDescription). See System Settings, General, Login Items."
        }
        openAtLogin = SMAppService.mainApp.status == .enabled
    }

    func retry() {
        Task {
            problem = nil
            await ensureService()
            await refresh()
        }
    }
}

private func jsString(_ s: String) -> String {
    let data = (try? JSONSerialization.data(withJSONObject: [s])) ?? Data("[\"\"]".utf8)
    let json = String(decoding: data, as: UTF8.self)
    return String(json.dropFirst().dropLast())
}
