import AppKit
import Combine
import Darwin
import QuartzCore
import SwiftUI

@main
struct AgentDeckNotchApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        Settings { EmptyView() }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var store: CompanionStore!
    private var notifications: NotificationCoordinator!
    private var notchPanel: NSPanel?
    private var menuPanel: NSPanel?
    private var statusItem: NSStatusItem?
    private var settingsWindow: NSWindow?
    private var cancellables = Set<AnyCancellable>()
    private var targetScreen: NSScreen?
    private var parentTimer: Timer?
    private var keyMonitor: Any?
    private var firstLayout = true

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        let store = CompanionStore(port: Self.portArgument())
        let notifications = NotificationCoordinator(store: store)
        store.notifications = notifications
        store.onShowSettings = { [weak self] in self?.showSettings() }
        self.store = store
        self.notifications = notifications
        configureSurface()
        observeStore()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(screenConfigurationChanged),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )
        installShortcutMonitor()
        store.start()
        monitorParentProcess()
    }

    func applicationWillTerminate(_ notification: Notification) {
        store?.stop()
        parentTimer?.invalidate()
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
    }

    private func configureSurface() {
        firstLayout = true
        if let screen = NSScreen.screens.first(where: Self.hasNotch) {
            targetScreen = screen
            removeMenuSurface()
            createNotchPanel()
        } else {
            targetScreen = NSScreen.main ?? NSScreen.screens.first
            notchPanel?.close()
            notchPanel = nil
            createMenuSurface()
        }
        updateSurface()
    }

    private func createNotchPanel() {
        guard notchPanel == nil else { return }
        let panel = makePanel(shadow: false)
        panel.contentView = NSHostingView(rootView: NotchRootView(store: store))
        notchPanel = panel
        panel.orderFrontRegardless()
    }

    private func createMenuSurface() {
        guard statusItem == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NotchGeometry.menuWidth)
        statusItem = item
        guard let button = item.button else { return }
        button.title = ""
        button.image = nil
        let host = NSHostingView(rootView: MenuBarPillView(store: store))
        host.frame = button.bounds
        host.autoresizingMask = [.width, .height]
        button.addSubview(host)

        let panel = makePanel(shadow: true)
        panel.contentView = NSHostingView(rootView: DetachedDashboardView(store: store))
        panel.level = .popUpMenu
        menuPanel = panel
    }

    private func removeMenuSurface() {
        menuPanel?.close()
        menuPanel = nil
        if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }
        statusItem = nil
    }

    private func makePanel(shadow: Bool) -> NSPanel {
        let panel = NSPanel(
            contentRect: .zero,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = shadow
        panel.level = .statusBar + 1
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.hidesOnDeactivate = false
        panel.isMovable = false
        return panel
    }

    private func observeStore() {
        store.objectWillChange
            .sink { [weak self] _ in
                DispatchQueue.main.async { self?.updateSurface() }
            }
            .store(in: &cancellables)
    }

    private func updateSurface() {
        if let notchPanel, let screen = targetScreen {
            let expanded = store.isExpanded
            let width = expanded ? NotchGeometry.expandedWidth : NotchGeometry.compactWidth
            let height = NotchGeometry.compactHeight + (expanded ? store.bodyHeight : 0)
            let frame = NSRect(
                x: screen.frame.midX - width / 2,
                y: screen.frame.maxY - height,
                width: width,
                height: height
            )
            animate(notchPanel, to: frame)
            notchPanel.orderFrontRegardless()
        }

        guard let menuPanel else { return }
        if store.isExpanded, let anchor = statusButtonFrame() {
            let height = store.bodyHeight
            let screen = statusItem?.button?.window?.screen ?? targetScreen
            let idealX = anchor.midX - NotchGeometry.expandedWidth / 2
            let minimumX = (screen?.frame.minX ?? idealX) + 8
            let maximumX = (screen?.frame.maxX ?? (idealX + NotchGeometry.expandedWidth))
                - NotchGeometry.expandedWidth - 8
            let frame = NSRect(
                x: min(max(idealX, minimumX), max(minimumX, maximumX)),
                y: anchor.minY - height - 6,
                width: NotchGeometry.expandedWidth,
                height: height
            )
            animate(menuPanel, to: frame)
            menuPanel.orderFrontRegardless()
        } else {
            menuPanel.orderOut(nil)
        }
    }

    private func animate(_ panel: NSPanel, to frame: NSRect) {
        guard panel.frame != frame else { return }
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        if firstLayout || reduceMotion {
            panel.setFrame(frame, display: true)
            firstLayout = false
            return
        }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.42
            context.timingFunction = CAMediaTimingFunction(controlPoints: 0.34, 1.15, 0.4, 1.0)
            panel.animator().setFrame(frame, display: true)
        }
    }

    private func statusButtonFrame() -> NSRect? {
        guard let button = statusItem?.button, let window = button.window else { return nil }
        return window.convertToScreen(button.convert(button.bounds, to: nil))
    }

    private func showSettings() {
        if settingsWindow == nil {
            let controller = NSHostingController(rootView: CompanionSettingsView(store: store))
            let window = NSWindow(contentViewController: controller)
            window.title = "AgentDeck Companion"
            window.styleMask = [.titled, .closable]
            window.setContentSize(NSSize(width: 380, height: 230))
            window.isReleasedWhenClosed = false
            window.center()
            settingsWindow = window
        }
        NSApp.activate(ignoringOtherApps: true)
        settingsWindow?.makeKeyAndOrderFront(nil)
    }

    private func installShortcutMonitor() {
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
                  event.charactersIgnoringModifiers?.lowercased() == "j"
            else { return event }
            self?.store.openAllAgents()
            return nil
        }
    }

    @objc private func screenConfigurationChanged() {
        configureSurface()
    }

    private static func hasNotch(_ screen: NSScreen) -> Bool {
        screen.safeAreaInsets.top > 0
            && (screen.auxiliaryTopLeftArea != nil || screen.auxiliaryTopRightArea != nil)
    }

    private static func portArgument() -> Int {
        guard let index = CommandLine.arguments.firstIndex(of: "--port"),
              CommandLine.arguments.indices.contains(index + 1),
              let port = Int(CommandLine.arguments[index + 1]),
              (1...65535).contains(port)
        else { return 4040 }
        return port
    }

    private func monitorParentProcess() {
        guard let index = CommandLine.arguments.firstIndex(of: "--parent-pid"),
              CommandLine.arguments.indices.contains(index + 1),
              let parentPID = Int32(CommandLine.arguments[index + 1])
        else { return }
        parentTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in
            if kill(parentPID, 0) != 0 {
                DispatchQueue.main.async { NSApp.terminate(nil) }
            }
        }
    }
}
