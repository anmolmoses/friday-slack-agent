// FRIDAY HUD overlay + global hotkey.
//
//   1. A borderless, transparent, click-through, always-on-top panel pinned to
//      the bottom-center of the screen, hosting a WKWebView that renders the
//      holographic indicator (hud.html, served by the voice daemon).
//   2. A global ⌃⌥F hotkey registered via Carbon RegisterEventHotKey — which
//      needs NO Accessibility / Input Monitoring permission (unlike skhd / event
//      taps). On press it runs `<friday-voice> toggle`, signalling the daemon.
//
// Usage:  friday-hud <hud-url> [friday-voice-path]
// Build:  swiftc -O overlay.swift -o friday-hud

import Cocoa
import WebKit
import Carbon

let args = CommandLine.arguments
let hudURL  = args.count > 1 ? args[1] : "http://127.0.0.1:3030/"
let toggleCmd = args.count > 2 ? args[2] : ""

// Run `<friday-voice> toggle` in a detached process. Non-capturing so it can be
// referenced from the C hotkey callback.
func fireToggle() {
    guard !toggleCmd.isEmpty else { NSLog("[friday-hud] no toggle cmd"); return }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/bash")
    p.arguments = [toggleCmd, "toggle"]
    p.environment = ProcessInfo.processInfo.environment   // inherits PATH (bun, brew)
    do { try p.run() } catch { NSLog("[friday-hud] toggle failed: \(error)") }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)   // no Dock icon, no menu bar

final class HUD: NSObject, NSApplicationDelegate {
    var panel: NSPanel!
    var web: WKWebView!
    var hotKeyRef: EventHotKeyRef?

    func applicationDidFinishLaunching(_ note: Notification) {
        buildPanel()
        registerHotKey()
    }

    func buildPanel() {
        // Square emblem pinned to the bottom-left corner (smaller, full circle in frame).
        let W: CGFloat = 240, H: CGFloat = 240
        let x: CGFloat = 22
        let y: CGFloat = 22

        panel = NSPanel(
            contentRect: NSRect(x: x, y: y, width: W, height: H),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.isMovable = false
        panel.ignoresMouseEvents = true
        panel.level = NSWindow.Level(rawValue: Int(CGShieldingWindowLevel()))
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        panel.hidesOnDeactivate = false

        web = WKWebView(frame: NSRect(x: 0, y: 0, width: W, height: H), configuration: WKWebViewConfiguration())
        web.setValue(false, forKey: "drawsBackground")
        if #available(macOS 12.0, *) { web.underPageBackgroundColor = .clear }
        web.autoresizingMask = [.width, .height]
        panel.contentView?.addSubview(web)
        panel.orderFrontRegardless()

        if let url = URL(string: hudURL) { web.load(URLRequest(url: url)) }
    }

    func registerHotKey() {
        // ⌃⌥F  (control + option + F). kVK_ANSI_F == 3.
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                 eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(),
            { (_, _, _) -> OSStatus in fireToggle(); return noErr },
            1, &spec, nil, nil)

        let id = EventHotKeyID(signature: OSType(0x46524459 /* 'FRDY' */), id: 1)
        let mods = UInt32(controlKey | optionKey)
        let status = RegisterEventHotKey(UInt32(kVK_ANSI_F), mods, id,
                                         GetApplicationEventTarget(), 0, &hotKeyRef)
        NSLog("[friday-hud] hotkey ⌃⌥F register status=\(status)")
    }
}

let delegate = HUD()
app.delegate = delegate
app.run()
