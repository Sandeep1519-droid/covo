import AppKit
import CovoKit
import WebKit

/// Connects a web view to the app: messages from the page ("open", "height", "drag"), and keeps the
/// web view on Covo's own address. Any other link opens in your browser.
@MainActor
final class Bridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    weak var model: CovoModel?
    weak var view: WKWebView?

    init(model: CovoModel) {
        self.model = model
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "open":
            if let route = body["route"] as? String, route.hasPrefix("#/") { model?.showWindow(route: route) }
        case "height":
            if let h = body["value"] as? Double { model?.panelHeight = min(max(h, 160), 620) }
        case "drag":
            model?.setDragRegions(drag: rects(body["drag"]), keep: rects(body["keep"]))
        case "theme":
            if let choice = body["value"] as? String { model?.applyTheme(choice, from: view) }
        default:
            break
        }
    }

    private func rects(_ v: Any?) -> [CGRect] {
        (v as? [[Double]] ?? []).compactMap { r in r.count == 4 ? CGRect(x: r[0], y: r[1], width: r[2], height: r[3]) : nil }
    }

    private func isCovo(_ url: URL?) -> Bool {
        guard let url, let model else { return false }
        if url.scheme == "about" { return true }
        return url.scheme == "http" && (url.host == "127.0.0.1" || url.host == "localhost") && url.port == model.api.home.port
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor action: WKNavigationAction,
        decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
    ) {
        if isCovo(action.request.url) { return decisionHandler(.allow) }
        if let url = action.request.url, url.scheme == "https" || url.scheme == "http" { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    /// Links that ask for a new window (target="_blank") open in your browser.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for action: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = action.request.url, !isCovo(url) { NSWorkspace.shared.open(url) }
        return nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }
}

/// The main window's web view. The window has no title bar of its own (the design puts the window
/// buttons in the sidebar), so the page reports which areas drag the window, as a title bar would.
final class MainWebView: WKWebView {
    private var drag: [CGRect] = []
    private var keep: [CGRect] = []

    func setDragRegions(drag: [CGRect], keep: [CGRect]) {
        self.drag = drag
        self.keep = keep
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        let pt = CGPoint(x: p.x, y: isFlipped ? p.y : bounds.height - p.y)
        if drag.contains(where: { $0.contains(pt) }), !keep.contains(where: { $0.contains(pt) }) {
            if event.clickCount == 2 { window?.performZoom(nil) } else { window?.performDrag(with: event) }
            return
        }
        super.mouseDown(with: event)
    }
}

/// Covo's main window. The frame (the toolbar strip, the icon rail and a thin edge) is the system's
/// translucent window material, so your desktop shows through it softly; the sidebar and the chat sit
/// in one solid, rounded panel inside it. The toolbar is native: back, forward and the sidebar switch,
/// centred with the window buttons.
@MainActor
final class MainWindow: NSWindowController, NSWindowDelegate, NSToolbarDelegate {
    let webView: WKWebView
    var loaded = false

    private static let back = NSToolbarItem.Identifier("covo.back")
    private static let forward = NSToolbarItem.Identifier("covo.forward")
    private static let sidebar = NSToolbarItem.Identifier("covo.sidebar")

    init(model: CovoModel) {
        webView = model.makeWebView(main: true)
        let w = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        w.title = "Covo"
        w.titleVisibility = .hidden
        w.titlebarAppearsTransparent = true
        w.titlebarSeparatorStyle = .none
        w.minSize = NSSize(width: 760, height: 520)
        w.isReleasedWhenClosed = false

        // The frame: translucent, and dimmer when the window isn't in front, like other Mac windows.
        let frame = NSVisualEffectView()
        frame.material = .sidebar
        frame.blendingMode = .behindWindow
        frame.state = .followsWindowActiveState
        w.contentView = frame
        // The page draws the rail and the panel; everything else stays clear so the frame shows.
        webView.translatesAutoresizingMaskIntoConstraints = false
        frame.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: frame.safeAreaLayoutGuide.topAnchor),
            webView.leadingAnchor.constraint(equalTo: frame.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: frame.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: frame.bottomAnchor),
        ])

        super.init(window: w)
        let toolbar = NSToolbar(identifier: "CovoMain")
        toolbar.delegate = self
        toolbar.displayMode = .iconOnly
        toolbar.allowsUserCustomization = false
        w.toolbar = toolbar
        w.toolbarStyle = .unifiedCompact
        w.delegate = self
        w.center()
        w.setFrameAutosaveName("CovoMain")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [Self.back, Self.forward, Self.sidebar, .flexibleSpace]
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        toolbarDefaultItemIdentifiers(toolbar)
    }

    func toolbar(
        _ toolbar: NSToolbar,
        itemForItemIdentifier id: NSToolbarItem.Identifier,
        willBeInsertedIntoToolbar flag: Bool
    ) -> NSToolbarItem? {
        let symbol: String
        let label: String
        let action: Selector
        switch id {
        case Self.back: (symbol, label, action) = ("chevron.left", "Back", #selector(goBack))
        case Self.forward: (symbol, label, action) = ("chevron.right", "Forward", #selector(goForward))
        case Self.sidebar: (symbol, label, action) = ("sidebar.left", "Show or hide the sidebar", #selector(toggleSidebar))
        default: return nil
        }
        let item = NSToolbarItem(itemIdentifier: id)
        item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)
        item.label = label
        item.toolTip = label
        item.isBordered = true
        item.target = self
        item.action = action
        return item
    }

    @objc private func goBack() { webView.evaluateJavaScript("history.back()") }
    @objc private func goForward() { webView.evaluateJavaScript("history.forward()") }
    @objc private func toggleSidebar() { webView.evaluateJavaScript("window.covo && window.covo.toggleSidebar()") }
}
