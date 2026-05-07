// Native macOS PCM player for Friday voice.
// Reads little-endian s16 mono PCM from stdin and plays it through AVAudioEngine.

import AVFoundation
import Foundation

let sampleRate = CommandLine.arguments.count > 1
    ? (Double(CommandLine.arguments[1]) ?? 24_000)
    : 24_000

guard let format = AVAudioFormat(
    commonFormat: .pcmFormatFloat32,
    sampleRate: sampleRate,
    channels: 1,
    interleaved: false
) else {
    fputs("[friday-audio] failed to create format\n", stderr)
    exit(1)
}

let engine = AVAudioEngine()
let player = AVAudioPlayerNode()
let group = DispatchGroup()
var started = false

engine.attach(player)
engine.connect(player, to: engine.mainMixerNode, format: format)

do {
    engine.prepare()
    try engine.start()
} catch {
    fputs("[friday-audio] engine start failed: \(error)\n", stderr)
    exit(1)
}

let input = FileHandle.standardInput

while true {
    let data = input.readData(ofLength: 8192)
    if data.isEmpty {
        break
    }

    autoreleasepool {
        let bytes = [UInt8](data)
        let frames = bytes.count / 2
        if frames == 0 {
            return
        }

        guard let buffer = AVAudioPCMBuffer(
            pcmFormat: format,
            frameCapacity: AVAudioFrameCount(frames)
        ) else {
            return
        }

        buffer.frameLength = AVAudioFrameCount(frames)
        guard let channel = buffer.floatChannelData?[0] else {
            return
        }

        for i in 0..<frames {
            let lo = UInt16(bytes[i * 2])
            let hi = UInt16(bytes[i * 2 + 1]) << 8
            let sample = Int16(bitPattern: hi | lo)
            channel[i] = Float(sample) / 32768.0
        }

        group.enter()
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { _ in
            group.leave()
        }
        if !started {
            player.play()
            started = true
        }
    }
}

if started {
    _ = group.wait(timeout: .now() + 30)
    player.stop()
}

engine.stop()
