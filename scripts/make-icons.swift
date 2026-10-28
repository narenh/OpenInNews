#!/usr/bin/env swift
// Draws the app and extension icons: a page with an arrow leaving it.
//
//   swift scripts/make-icons.swift
//
// Writes App/Assets.xcassets/AppIcon.appiconset/icon.png (1024, full bleed; iOS
// applies the mask) and Extension/Resources/icons/<size>.png (rounded).

import AppKit

func draw(size: CGFloat, rounded: Bool) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size),
                               bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let cg = NSGraphicsContext.current!.cgContext
    let s = size / 1024

    // Background: indigo to violet, top to bottom.
    let bounds = CGRect(x: 0, y: 0, width: size, height: size)
    if rounded {
        cg.addPath(CGPath(roundedRect: bounds, cornerWidth: 225 * s, cornerHeight: 225 * s, transform: nil))
        cg.clip()
    }
    let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [
        CGColor(red: 0.49, green: 0.36, blue: 0.96, alpha: 1),
        CGColor(red: 0.27, green: 0.24, blue: 0.85, alpha: 1)
    ] as CFArray, locations: [0, 1])!
    cg.drawLinearGradient(gradient, start: CGPoint(x: 0, y: size), end: .zero, options: [])

    // Page with a folded corner.
    let white = CGColor(red: 1, green: 1, blue: 1, alpha: 1)
    let r = 40 * s
    let page = CGMutablePath()
    page.move(to: CGPoint(x: 495 * s, y: 190 * s))
    page.addArc(tangent1End: CGPoint(x: 250 * s, y: 190 * s), tangent2End: CGPoint(x: 250 * s, y: 830 * s), radius: r)
    page.addArc(tangent1End: CGPoint(x: 250 * s, y: 830 * s), tangent2End: CGPoint(x: 600 * s, y: 830 * s), radius: r)
    page.addLine(to: CGPoint(x: 600 * s, y: 830 * s))
    page.addLine(to: CGPoint(x: 740 * s, y: 690 * s))
    page.addArc(tangent1End: CGPoint(x: 740 * s, y: 190 * s), tangent2End: CGPoint(x: 250 * s, y: 190 * s), radius: r)
    page.closeSubpath()
    cg.setFillColor(white)
    cg.addPath(page)
    cg.fillPath()
    cg.setFillColor(CGColor(red: 0.80, green: 0.78, blue: 0.98, alpha: 1))
    let fold = CGMutablePath()
    fold.move(to: CGPoint(x: 600 * s, y: 830 * s))
    fold.addLine(to: CGPoint(x: 600 * s, y: 690 * s))
    fold.addLine(to: CGPoint(x: 740 * s, y: 690 * s))
    fold.closeSubpath()
    cg.addPath(fold)
    cg.fillPath()

    // Text lines.
    cg.setFillColor(CGColor(red: 0.27, green: 0.24, blue: 0.85, alpha: 0.35))
    for (y, width) in [(600.0, 260.0), (500.0, 380.0), (400.0, 380.0), (300.0, 240.0)] {
        cg.addPath(CGPath(roundedRect: CGRect(x: 320 * s, y: y * s, width: width * s, height: 44 * s),
                          cornerWidth: 22 * s, cornerHeight: 22 * s, transform: nil))
    }
    cg.fillPath()

    // Arrow out of the lower right, on a disc.
    let disc = CGRect(x: 600 * s, y: 110 * s, width: 320 * s, height: 320 * s)
    cg.setFillColor(CGColor(red: 1, green: 0.42, blue: 0.36, alpha: 1))
    cg.fillEllipse(in: disc)
    cg.setStrokeColor(white)
    cg.setLineWidth(46 * s)
    cg.setLineCap(.round)
    cg.setLineJoin(.round)
    cg.move(to: CGPoint(x: 690 * s, y: 200 * s))
    cg.addLine(to: CGPoint(x: 830 * s, y: 340 * s))
    cg.move(to: CGPoint(x: 720 * s, y: 340 * s))
    cg.addLine(to: CGPoint(x: 830 * s, y: 340 * s))
    cg.addLine(to: CGPoint(x: 830 * s, y: 230 * s))
    cg.strokePath()

    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

let root = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().deletingLastPathComponent()
try draw(size: 1024, rounded: false)
    .write(to: root.appendingPathComponent("App/Assets.xcassets/AppIcon.appiconset/icon.png"))
for size in [16, 32, 48, 96, 128, 256, 512] {
    try draw(size: CGFloat(size), rounded: true)
        .write(to: root.appendingPathComponent("Extension/Resources/icons/\(size).png"))
}
print("icons written")
