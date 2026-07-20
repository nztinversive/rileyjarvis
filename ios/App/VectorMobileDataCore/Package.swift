// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "VectorMobileDataCore",
    platforms: [.iOS(.v15), .macOS(.v13)],
    products: [
        .library(name: "VectorMobileDataCore", targets: ["VectorMobileDataCore"])
    ],
    targets: [
        .target(name: "VectorMobileDataCore"),
        .testTarget(name: "VectorMobileDataCoreTests", dependencies: ["VectorMobileDataCore"])
    ]
)
