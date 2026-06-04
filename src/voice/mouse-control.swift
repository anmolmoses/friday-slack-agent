// Tiny mouse controller for Friday voice.
// Posts CoreGraphics mouse events and flashes an orange ring at the controlled point.

import Cocoa
import ApplicationServices
import CoreGraphics
import Foundation

func arg(_ i: Int, _ fallback: String = "") -> String {
    CommandLine.arguments.count > i ? CommandLine.arguments[i] : fallback
}

func num(_ i: Int, _ fallback: Double = 0) -> Double {
    Double(arg(i)) ?? fallback
}

let action = arg(1)
let x = num(2)
let y = num(3)
let x2 = num(4, x)
let y2 = num(5, y)
let durationMs = max(60, Int(num(6, 260)))

let axOptions = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
if !AXIsProcessTrustedWithOptions(axOptions) {
    fputs("Accessibility permission required for friday-mouse. Grant it in System Settings > Privacy & Security > Accessibility, then run again.\n", stderr)
    exit(77)
}

if action == "check" {
    print("friday-mouse accessibility trusted")
    exit(0)
}

func post(_ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton = .left) {
    CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button)?
        .post(tap: .cghidEventTap)
}

func move(_ point: CGPoint) {
    CGWarpMouseCursorPosition(point)
    post(.mouseMoved, point)
}

func click(_ point: CGPoint) {
    move(point)
    post(.leftMouseDown, point)
    usleep(45_000)
    post(.leftMouseUp, point)
}

func drag(_ start: CGPoint, _ end: CGPoint) {
    move(start)
    post(.leftMouseDown, start)
    let steps = 24
    for i in 1...steps {
        let t = CGFloat(i) / CGFloat(steps)
        let p = CGPoint(
            x: start.x + (end.x - start.x) * t,
            y: start.y + (end.y - start.y) * t
        )
        move(p)
        usleep(useconds_t(max(2_000, durationMs * 1000 / steps)))
    }
    post(.leftMouseUp, end)
}

let p = CGPoint(x: x, y: y)
let q = CGPoint(x: x2, y: y2)

switch action {
case "move":
    move(p)
case "click":
    click(p)
case "double_click":
    click(p)
    usleep(90_000)
    click(p)
case "drag":
    drag(p, q)
default:
    fputs("usage: friday-mouse <check|move|click|double_click|drag> x y [toX toY durationMs]\n", stderr)
    exit(2)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

final class RingView: NSView {
    override func draw(_ dirtyRect: NSRect) {
        NSColor.clear.setFill()
        dirtyRect.fill()
        let ring = NSBezierPath(ovalIn: bounds.insetBy(dx: 6, dy: 6))
        NSColor(calibratedRed: 1.0, green: 0.45, blue: 0.05, alpha: 0.95).setStroke()
        ring.lineWidth = 5
        ring.stroke()
    }
}

let size: CGFloat = 74
let screen = NSScreen.screens.first ?? NSScreen.main
let screenHeight = screen?.frame.height ?? 0
let window = NSWindow(
    contentRect: NSRect(x: p.x - size / 2, y: screenHeight - p.y - size / 2, width: size, height: size),
    styleMask: [.borderless],
    backing: .buffered,
    defer: false
)
window.isOpaque = false
window.backgroundColor = .clear
window.hasShadow = false
window.ignoresMouseEvents = true
window.level = NSWindow.Level(rawValue: Int(CGShieldingWindowLevel()))
window.contentView = RingView(frame: NSRect(x: 0, y: 0, width: size, height: size))
window.orderFrontRegardless()

DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
    app.terminate(nil)
}
app.run()
