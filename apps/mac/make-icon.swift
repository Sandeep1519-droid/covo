// Makes Resources/AppIcon.icns from the app's purple Squircle avatar (the Figma "Bot avatar"),
// drawn on a rounded tile. Run by build.sh when the icon is missing: swift make-icon.swift
import AppKit

let root = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ".")
let svgURL = root.appendingPathComponent("../app/src/assets/avatars/squircle.svg")
var svg = try String(contentsOf: svgURL, encoding: .utf8)
svg = svg.replacingOccurrences(of: "#5CB8F2", with: "#8B5CF6", options: .caseInsensitive) // avatar "purple"
guard let avatar = NSImage(data: Data(svg.utf8)) else { fatalError("Couldn't read the avatar") }

let set = root.appendingPathComponent("build/AppIcon.iconset")
try? FileManager.default.removeItem(at: set)
try FileManager.default.createDirectory(at: set, withIntermediateDirectories: true)
for (name, px) in [("16x16", 16), ("16x16@2x", 32), ("32x32", 32), ("32x32@2x", 64), ("128x128", 128),
                   ("128x128@2x", 256), ("256x256", 256), ("256x256@2x", 512), ("512x512", 512), ("512x512@2x", 1024)] {
    let s = CGFloat(px)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    // macOS icon grid: a rounded tile inset from the edges, the avatar centred on it.
    let tile = NSRect(x: s * 0.1, y: s * 0.1, width: s * 0.8, height: s * 0.8)
    NSColor(calibratedWhite: 0.11, alpha: 1).setFill()
    NSBezierPath(roundedRect: tile, xRadius: s * 0.18, yRadius: s * 0.18).fill()
    let a = s * 0.52
    avatar.draw(in: NSRect(x: (s - a) / 2, y: (s - a) / 2 - s * 0.01, width: a, height: a * 51 / 50))
    NSGraphicsContext.restoreGraphicsState()
    try rep.representation(using: .png, properties: [:])!.write(to: set.appendingPathComponent("icon_\(name).png"))
}
print(set.path)
