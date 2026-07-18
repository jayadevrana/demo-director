// cursor — native input driver for Demo Director.
// Posts CGEvents for presenter-grade smooth mouse movement, clicks, drags,
// momentum scrolling, and human-paced typing.
//
// Build:  swiftc -O -o cursor cursor.swift
// Requires the calling app (your terminal / Claude) to have Accessibility permission.
//
// Usage:
//   cursor position
//   cursor displays
//   cursor move <x> <y> [ms]
//   cursor click [x y] [--right] [--double]
//   cursor drag <x1> <y1> <x2> <y2> [ms]
//   cursor scroll <dx> <dy> [ms]          (dy > 0 scrolls the page DOWN)
//   cursor type <text> [cps]
//   cursor key <name> [cmd] [shift] [alt] [ctrl]

import CoreGraphics
import Foundation

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write(("{\"error\":\"" + msg + "\"}\n").data(using: .utf8)!)
    exit(1)
}

func ok(_ json: String = "{\"ok\":true}") {
    print(json)
}

func mouseLoc() -> CGPoint {
    CGEvent(source: nil)?.location ?? .zero
}

func post(_ e: CGEvent?) {
    e?.post(tap: .cghidEventTap)
}

func easeInOutCubic(_ t: Double) -> Double {
    t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2
}

func pauseMicro(_ s: Double) {
    usleep(UInt32(max(s, 0) * 1_000_000))
}

// Smooth quadratic-bezier glide with ease-in-out — reads as a human hand, not a teleport.
func moveTo(_ target: CGPoint, ms: Double) {
    let start = mouseLoc()
    let dx = target.x - start.x
    let dy = target.y - start.y
    let dist = (dx * dx + dy * dy).squareRoot()
    if dist < 1 {
        post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                     mouseCursorPosition: target, mouseButton: .left))
        return
    }
    let arc = min(dist * 0.08, 40.0) // gentle curvature, capped
    let mid = CGPoint(x: (start.x + target.x) / 2 - dy / dist * arc,
                      y: (start.y + target.y) / 2 + dx / dist * arc)
    let dur = max(ms, 16) / 1000.0
    let steps = max(Int(dur * 120), 2)
    for i in 1...steps {
        let t = easeInOutCubic(Double(i) / Double(steps))
        let u = 1 - t
        let x = u * u * start.x + 2 * u * t * mid.x + t * t * target.x
        let y = u * u * start.y + 2 * u * t * mid.y + t * t * target.y
        post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                     mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left))
        pauseMicro(dur / Double(steps))
    }
}

func click(at p: CGPoint, right: Bool, clicks: Int) {
    let downType: CGEventType = right ? .rightMouseDown : .leftMouseDown
    let upType: CGEventType = right ? .rightMouseUp : .leftMouseUp
    let btn: CGMouseButton = right ? .right : .left
    for i in 1...clicks {
        let down = CGEvent(mouseEventSource: nil, mouseType: downType,
                           mouseCursorPosition: p, mouseButton: btn)
        down?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        post(down)
        pauseMicro(0.045)
        let up = CGEvent(mouseEventSource: nil, mouseType: upType,
                         mouseCursorPosition: p, mouseButton: btn)
        up?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        post(up)
        if i < clicks { pauseMicro(0.09) }
    }
}

func drag(from a: CGPoint, to b: CGPoint, ms: Double) {
    moveTo(a, ms: 250)
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown,
                 mouseCursorPosition: a, mouseButton: .left))
    pauseMicro(0.12)
    let dur = max(ms, 100) / 1000.0
    let steps = max(Int(dur * 120), 2)
    for i in 1...steps {
        let t = easeInOutCubic(Double(i) / Double(steps))
        let p = CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
        post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged,
                     mouseCursorPosition: p, mouseButton: .left))
        pauseMicro(dur / Double(steps))
    }
    pauseMicro(0.1)
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp,
                 mouseCursorPosition: b, mouseButton: .left))
}

// Eased pixel scrolling — feels like trackpad momentum, not notchy wheel clicks.
func scroll(dx: Double, dy: Double, ms: Double) {
    let dur = max(ms, 50) / 1000.0
    let steps = max(Int(dur * 90), 2)
    var sentX = 0.0
    var sentY = 0.0
    for i in 1...steps {
        let t = easeInOutCubic(Double(i) / Double(steps))
        let stepY = (dy * t - sentY).rounded()
        let stepX = (dx * t - sentX).rounded()
        sentY += stepY
        sentX += stepX
        // CGEvent: positive wheel1 scrolls content UP; we expose dy>0 = page moves DOWN.
        let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
                        wheel1: Int32(-stepY), wheel2: Int32(-stepX), wheel3: 0)
        post(e)
        pauseMicro(dur / Double(steps))
    }
}

func typeText(_ text: String, cps: Double) {
    let base = 1.0 / max(cps, 1)
    for ch in text {
        var units = Array(String(ch).utf16)
        let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
        down?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
        post(down)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        up?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
        post(up)
        // Human rhythm: jittered inter-key delay, longer after punctuation.
        var delay = base * Double.random(in: 0.65...1.45)
        if ".,;:!? ".contains(ch) { delay *= 1.6 }
        pauseMicro(delay)
    }
}

let keyCodes: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "forwarddelete": 117,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
    "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4, "i": 34,
    "j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31, "p": 35, "q": 12,
    "r": 15, "s": 1, "t": 17, "u": 32, "v": 9, "w": 13, "x": 7, "y": 16, "z": 6,
    "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26,
    "8": 28, "9": 25, "-": 27, "=": 24, "[": 33, "]": 30, "\\": 42, ";": 41,
    "'": 39, ",": 43, ".": 47, "/": 44, "`": 50,
]

func pressKey(_ name: String, mods: [String]) {
    guard let code = keyCodes[name.lowercased()] else { fail("unknown key: \(name)") }
    var flags: CGEventFlags = []
    for m in mods {
        switch m.lowercased() {
        case "cmd", "command", "meta": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt", "option", "opt": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        default: fail("unknown modifier: \(m)")
        }
    }
    let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
    down?.flags = flags
    post(down)
    pauseMicro(0.03)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
    up?.flags = flags
    post(up)
}

func displaysJSON() -> String {
    var ids = [CGDirectDisplayID](repeating: 0, count: 16)
    var count: UInt32 = 0
    CGGetActiveDisplayList(16, &ids, &count)
    let main = CGMainDisplayID()
    var parts: [String] = []
    for i in 0..<Int(count) {
        let b = CGDisplayBounds(ids[i])
        parts.append("{\"id\":\(ids[i]),\"main\":\(ids[i] == main),\"x\":\(Int(b.origin.x)),\"y\":\(Int(b.origin.y)),\"width\":\(Int(b.width)),\"height\":\(Int(b.height))}")
    }
    return "[" + parts.joined(separator: ",") + "]"
}

// ---- main ----

let args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else { fail("no command") }
let rest = Array(args.dropFirst())

func num(_ i: Int, _ fallback: Double? = nil) -> Double {
    if i < rest.count, let v = Double(rest[i]) { return v }
    if let f = fallback { return f }
    fail("missing/invalid numeric argument #\(i + 1) for \(cmd)")
}

switch cmd {
case "position":
    let p = mouseLoc()
    ok("{\"x\":\(Int(p.x)),\"y\":\(Int(p.y))}")
case "displays":
    ok(displaysJSON())
case "move":
    moveTo(CGPoint(x: num(0), y: num(1)), ms: num(2, 600))
    ok()
case "click":
    let right = rest.contains("--right")
    let double = rest.contains("--double")
    let coords = rest.filter { !$0.hasPrefix("--") }
    var p = mouseLoc()
    if coords.count >= 2, let x = Double(coords[0]), let y = Double(coords[1]) {
        p = CGPoint(x: x, y: y)
        moveTo(p, ms: 0)
        pauseMicro(0.05)
    }
    click(at: p, right: right, clicks: double ? 2 : 1)
    ok()
case "drag":
    drag(from: CGPoint(x: num(0), y: num(1)),
         to: CGPoint(x: num(2), y: num(3)), ms: num(4, 800))
    ok()
case "scroll":
    scroll(dx: num(0), dy: num(1), ms: num(2, 900))
    ok()
case "type":
    guard let text = rest.first else { fail("type requires text") }
    typeText(text, cps: rest.count > 1 ? (Double(rest[1]) ?? 12) : 12)
    ok()
case "key":
    guard let name = rest.first else { fail("key requires a key name") }
    pressKey(name, mods: Array(rest.dropFirst()))
    ok()
default:
    fail("unknown command: \(cmd)")
}
