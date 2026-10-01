// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "AgentDeckNotch",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "AgentDeckNotch", targets: ["AgentDeckNotch"]),
        // Issue #91: captures one window the owner shared, for a paired phone.
        .executable(name: "AgentDeckWindowView", targets: ["AgentDeckWindowView"]),
    ],
    targets: [
        .executableTarget(name: "AgentDeckNotch"),
        .executableTarget(name: "AgentDeckWindowView"),
        .testTarget(name: "AgentDeckNotchTests", dependencies: ["AgentDeckNotch"]),
        .testTarget(name: "AgentDeckWindowViewTests", dependencies: ["AgentDeckWindowView"]),
    ]
)
