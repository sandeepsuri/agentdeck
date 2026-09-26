import AppKit
import Combine
import Darwin
import SwiftUI

@main
struct AgentDeckNotchApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    var body: some Scene { Settings { EmptyView() } }
}

private final class StatusContentView<Content: View>: NSHostingView<Content> {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var store: CompanionStore!
    private var notifications: NotificationCoordinator!
    private var statusItem: NSStatusItem!
    private var popover: NSPopover!
    private var settingsWindow: NSWindow?
    private var parentTimer: Timer?
    private var keyMonitor: Any?
    private var cancellables = Set<AnyCancellable>()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        store = CompanionStore(port: Self.portArgument())
        notifications = NotificationCoordinator(store: store)
        store.notifications = notifications
        store.onShowSettings = { [weak self] in self?.showSettings() }
        statusItem = NSStatusBar.system.statusItem(withLength: CompanionGeometry.menuWidth)
        if let button = statusItem.button {
            button.title = ""
            button.action = #selector(togglePopover)
            button.target = self
            let host = StatusContentView(rootView: MenuBarPillView(store: store))
            host.frame = button.bounds
            host.autoresizingMask = [.width, .height]
            button.addSubview(host)
        }
        store.objectWillChange.sink { [weak self] _ in
            DispatchQueue.main.async { self?.updateStatusAccessibility() }
        }.store(in: &cancellables)
        updateStatusAccessibility()
        popover = NSPopover()
        popover.behavior = .transient
        popover.animates = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
                  event.charactersIgnoringModifiers?.lowercased() == "j" else { return event }
            self?.store.openAllAgents()
            return nil
        }
        store.start()
        monitorParentProcess()
    }

    @objc private func togglePopover() {
        guard let button = statusItem.button else { return }
        popover.animates = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        if popover.isShown {
            popover.performClose(nil)
        } else {
            store.refreshUsage()
            let size = (button.window?.screen ?? NSScreen.main).map {
                CompanionGeometry.popoverSize(in: $0.visibleFrame)
            } ?? NSSize(width: CompanionGeometry.popoverWidth, height: CompanionGeometry.popoverHeight)
            popover.contentSize = size
            popover.contentViewController = NSHostingController(rootView:
                DetachedDashboardView(store: store, width: size.width, height: size.height))
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            popover.contentViewController?.view.window?.makeKey()
        }
    }

    private func updateStatusAccessibility() {
        let label = store.connected
            ? "AgentDeck, \(store.display.actionableCount) need you, \(store.display.runningCount) running"
            : "AgentDeck reconnecting"
        statusItem.button?.setAccessibilityLabel(label)
        statusItem.button?.toolTip = label
    }

    func applicationWillTerminate(_ notification: Notification) {
        store?.stop()
        parentTimer?.invalidate()
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
    }

    private func showSettings() {
        if settingsWindow == nil {
            let window = NSWindow(contentViewController: NSHostingController(rootView: CompanionSettingsView(store: store)))
            window.title = "AgentDeck Companion"
            window.styleMask = [.titled, .closable]
            window.setContentSize(NSSize(width: 380, height: 190))
            window.isReleasedWhenClosed = false
            window.center()
            settingsWindow = window
        }
        NSApp.activate(ignoringOtherApps: true)
        settingsWindow?.makeKeyAndOrderFront(nil)
    }

    private static func portArgument() -> Int {
        guard let index = CommandLine.arguments.firstIndex(of: "--port"),
              CommandLine.arguments.indices.contains(index + 1),
              let port = Int(CommandLine.arguments[index + 1]), (1...65535).contains(port)
        else { return 4040 }
        return port
    }

    private func monitorParentProcess() {
        guard let index = CommandLine.arguments.firstIndex(of: "--parent-pid"),
              CommandLine.arguments.indices.contains(index + 1),
              let parentPID = Int32(CommandLine.arguments[index + 1]) else { return }
        parentTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in
            if kill(parentPID, 0) != 0 { DispatchQueue.main.async { NSApp.terminate(nil) } }
        }
    }
}
