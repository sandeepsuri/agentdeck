// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "AgentDeckNotch",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "AgentDeckNotch", targets: ["AgentDeckNotch"]),
    ],
    targets: [
        .executableTarget(name: "AgentDeckNotch"),
        .testTarget(name: "AgentDeckNotchTests", dependencies: ["AgentDeckNotch"]),
    ]
)
