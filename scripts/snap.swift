// Takes Retina screenshots of Covo's app for the README (docs/images), from a running Covo.
// It renders the app in a WebKit view that isn't on screen, so nothing on your desktop is captured.
//
//   swift scripts/snap.swift "<sign-in link from covo app or covo demo --app>" docs/images \
//     chat=#/bot:dark library=#/library:dark models=#/settings/models:light
//
// Each shot is name=route:theme (dark or light). Sizes are 1440×900 points, saved at 2×.

import AppKit
import WebKit

final class Snapper: NSObject, WKNavigationDelegate {
  let web: WKWebView
  let window: NSWindow
  let outDir: URL
  var shots: [(name: String, route: String, dark: Bool)]
  var started = false

  init(link: URL, outDir: URL, shots: [(String, String, Bool)]) {
    self.outDir = outDir
    self.shots = shots
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    let frame = NSRect(x: -10_000, y: -10_000, width: 1440, height: 900)
    window = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
    web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1440, height: 900), configuration: config)
    super.init()
    window.contentView = web
    window.appearance = NSAppearance(named: shots.first?.2 == false ? .aqua : .darkAqua)
    window.orderBack(nil)
    web.navigationDelegate = self
    web.load(URLRequest(url: link))
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    guard !started else { return }
    started = true
    // Give the page time to trade its one-time code for a session.
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { self.next() }
  }

  var theme: String? = nil

  func next() {
    guard !shots.isEmpty else { NSApp.terminate(nil); return }
    let s = shots.removeFirst()
    let want = s.dark ? "dark" : "light"
    window.appearance = NSAppearance(named: s.dark ? .darkAqua : .aqua)
    // The app keeps its theme choice in this browser; a new theme needs a reload to take effect.
    let reload = theme != want
    theme = want
    let js =
      "localStorage.setItem('covo.theme', '\(want)'); location.hash = \(String(reflecting: s.route));"
      + (reload ? " location.reload();" : "")
    web.evaluateJavaScript(js) { _, _ in
      DispatchQueue.main.asyncAfter(deadline: .now() + (reload ? 3.5 : 2.0)) {
        let c = WKSnapshotConfiguration()
        c.afterScreenUpdates = true
        self.web.takeSnapshot(with: c) { image, error in
          if let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
            let png = rep.representation(using: .png, properties: [:])
          {
            let url = self.outDir.appendingPathComponent("\(s.name).png")
            try? png.write(to: url)
            print("saved \(url.path) (\(rep.pixelsWide)×\(rep.pixelsHigh))")
          } else {
            print("couldn't take \(s.name): \(error?.localizedDescription ?? "no image")")
          }
          self.next()
        }
      }
    }
  }
}

let args = CommandLine.arguments.dropFirst()
guard args.count >= 3, let link = URL(string: args[args.startIndex]) else {
  print("usage: swift scripts/snap.swift <sign-in link> <out dir> name=route:theme …")
  exit(2)
}
let outDir = URL(fileURLWithPath: args[args.startIndex + 1])
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
let shots: [(String, String, Bool)] = args.dropFirst(2).map { spec in
  let parts = spec.split(separator: "=", maxSplits: 1).map(String.init)
  let routeTheme = parts.count > 1 ? parts[1] : "#/"
  let dark = !routeTheme.hasSuffix(":light")
  let route = routeTheme.replacingOccurrences(of: ":light", with: "").replacingOccurrences(of: ":dark", with: "")
  return (parts[0], route, dark)
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let snapper = Snapper(link: link, outDir: outDir, shots: shots)
app.run()
