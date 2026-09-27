// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "AgentDeckApp",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "AgentDeckApp", targets: ["AgentDeckApp"])],
    targets: [.executableTarget(name: "AgentDeckApp")]
)
