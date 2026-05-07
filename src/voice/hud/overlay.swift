// FRIDAY HUD overlay + global hotkey.
//
//   1. A borderless, transparent, click-through, always-on-top panel pinned to
//      the bottom-center of the screen, hosting a WKWebView that renders the
//      holographic indicator (hud.html, served by the voice daemon).
//   2. Global hotkeys registered via Carbon RegisterEventHotKey — which
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
let shortcutDir = "/tmp/friday-voice"
let shortcutLog = "/tmp/friday-voice/shortcut.log"
let hotKeyDebounceMs: TimeInterval = 1200
var lastHotKeyAt = Date(timeIntervalSince1970: 0)

func logShortcut(_ message: String) {
    let stamp = ISO8601DateFormatter().string(from: Date())
    let line = "[\(stamp)] friday-hud \(message)\n"
    if let data = line.data(using: .utf8) {
        try? FileManager.default.createDirectory(atPath: shortcutDir, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: shortcutLog) {
            FileManager.default.createFile(atPath: shortcutLog, contents: nil)
        }
        if let handle = try? FileHandle(forWritingTo: URL(fileURLWithPath: shortcutLog)) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            _ = try? handle.write(contentsOf: data)
        }
    }
    NSLog("[friday-hud] \(message)")
}

// Run `<friday-voice> toggle` in a detached process. Non-capturing so it can be
// referenced from the C hotkey callback.
let hotKeyLabels: [UInt32: String] = [
    1: "ctrl+option+F",
    2: "cmd+option+space",
    3: "ctrl+option+cmd+F",
]

func hotKeyName(from event: EventRef?) -> String {
    guard let event else { return "unknown" }
    var hotKeyId = EventHotKeyID()
    let status = GetEventParameter(
        event,
        EventParamName(kEventParamDirectObject),
        EventParamType(typeEventHotKeyID),
        nil,
        MemoryLayout<EventHotKeyID>.size,
        nil,
        &hotKeyId
    )
    guard status == noErr else { return "unknown" }
    return hotKeyLabels[hotKeyId.id] ?? "unknown"
}

func fireToggle(_ source: String) {
    guard !toggleCmd.isEmpty else { logShortcut("no toggle cmd"); return }
    let now = Date()
    let elapsedMs = now.timeIntervalSince(lastHotKeyAt) * 1000
    if elapsedMs >= 0 && elapsedMs < hotKeyDebounceMs {
        logShortcut("hotkey \(source) ignored duplicate (\(Int(elapsedMs))ms)")
        return
    }
    lastHotKeyAt = now

    logShortcut("hotkey \(source) pressed -> \(toggleCmd) toggle")
    let p = Process()
    p.executableURL = URL(fileURLWithPath: toggleCmd)
    p.arguments = ["toggle"]
    var env = ProcessInfo.processInfo.environment
    env["FRIDAY_VOICE_HOTKEY"] = "1"
    env["FRIDAY_VOICE_HOTKEY_SOURCE"] = source
    p.environment = env   // inherits PATH (bun, brew)
    p.terminationHandler = { process in
        if process.terminationStatus != 0 {
            logShortcut("toggle exited status=\(process.terminationStatus) for \(source)")
        }
    }
    do { try p.run() } catch { logShortcut("toggle failed: \(error)") }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)   // no Dock icon, no menu bar

final class HUD: NSObject, NSApplicationDelegate {
    var panel: NSPanel!
    var web: WKWebView!
    var hotKeyRefs: [EventHotKeyRef?] = []

    func applicationDidFinishLaunching(_ note: Notification) {
        buildPanel()
        registerHotKeys()
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

    func registerHotKeys() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                 eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(),
            { (_, event, _) -> OSStatus in fireToggle(hotKeyName(from: event)); return noErr },
            1, &spec, nil, nil)

        registerHotKey(name: "ctrl+option+F", keyCode: UInt32(kVK_ANSI_F), mods: UInt32(controlKey | optionKey), idValue: 1)
        registerHotKey(name: "cmd+option+space", keyCode: UInt32(kVK_Space), mods: UInt32(cmdKey | optionKey), idValue: 2)
        registerHotKey(name: "ctrl+option+cmd+F", keyCode: UInt32(kVK_ANSI_F), mods: UInt32(controlKey | optionKey | cmdKey), idValue: 3)
    }

    func registerHotKey(name: String, keyCode: UInt32, mods: UInt32, idValue: UInt32) {
        let id = EventHotKeyID(signature: OSType(0x46524459 /* 'FRDY' */), id: idValue)
        var ref: EventHotKeyRef?
        let status = RegisterEventHotKey(keyCode, mods, id,
                                         GetApplicationEventTarget(), 0, &ref)
        if status == noErr { hotKeyRefs.append(ref) }
        logShortcut("hotkey \(name) register status=\(status)")
    }
}

let delegate = HUD()
app.delegate = delegate
app.run()
