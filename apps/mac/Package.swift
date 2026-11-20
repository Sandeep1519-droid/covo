// swift-tools-version: 6.0
// Covo.app, the Mac app (Phase 3 M4). Build it with: bun run mac:build (see build.sh).
import PackageDescription

let package = Package(
    name: "CovoMac",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "Covo", targets: ["Covo"])],
    targets: [
        // The parts with no UI: the API client, what the menu bar shows, when to notify. Tested.
        .target(name: "CovoKit", path: "Sources/CovoKit"),
        // The app: menu bar icon and panel, the window, notifications.
        .executableTarget(name: "Covo", dependencies: ["CovoKit"], path: "Sources/Covo"),
        .testTarget(name: "CovoKitTests", dependencies: ["CovoKit"], path: "Tests/CovoKitTests"),
    ],
    swiftLanguageModes: [.v5]
)
