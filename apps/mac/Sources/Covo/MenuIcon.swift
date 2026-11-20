import AppKit
import CovoKit

/// The menu bar icon, drawn as a template image (macOS tints it for light and dark menu bars): the
/// bot's rounded face with two eyes, like the avatars in the app.
enum MenuIcon {
    private static var cache: [String: NSImage] = [:]

    static func image(for state: MenuState) -> NSImage {
        let key: String
        switch state {
        case .offline: key = "offline"
        case .working: key = "working"
        case .paused: key = "paused"
        case .idle, .waiting: key = "idle"
        }
        if let i = cache[key] { return i }
        let img = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
            draw(key)
            return true
        }
        img.isTemplate = true
        img.accessibilityDescription = state.label
        cache[key] = img
        return img
    }

    private static func draw(_ key: String) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let face = CGRect(x: 1.5, y: 2, width: 15, height: 13.5)
        let path = CGPath(roundedRect: face, cornerWidth: 5.5, cornerHeight: 5.5, transform: nil)
        ctx.setFillColor(NSColor.black.cgColor)
        ctx.setStrokeColor(NSColor.black.cgColor)
        if key == "offline" {
            ctx.setLineWidth(1.4)
            ctx.addPath(path)
            ctx.strokePath()
        } else {
            ctx.addPath(path)
            ctx.fillPath()
        }
        // The eyes: cut out of the face (or drawn, when the face is only an outline).
        ctx.setBlendMode(key == "offline" ? .normal : .clear)
        if key == "paused" {
            for x in [5.5, 10.5] {
                ctx.fill(CGRect(x: x, y: 8, width: 2.6, height: 1.4)) // closed eyes
            }
        } else {
            for x in [5.8, 10.2] {
                let eye = CGRect(x: x, y: 6.5, width: 2.2, height: 4.6)
                ctx.addPath(CGPath(roundedRect: eye, cornerWidth: 1.1, cornerHeight: 1.1, transform: nil))
                ctx.fillPath()
            }
        }
        if key == "working" {
            ctx.setBlendMode(.clear)
            ctx.fillEllipse(in: CGRect(x: 11.5, y: 11, width: 7, height: 7))
            ctx.setBlendMode(.normal)
            ctx.fillEllipse(in: CGRect(x: 13, y: 12.5, width: 4.5, height: 4.5)) // a busy dot
        }
    }
}
