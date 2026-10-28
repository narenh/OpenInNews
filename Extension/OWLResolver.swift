import CryptoKit
import Foundation

/// Swift port of owl.js, so Safari's lookups come from the extension's own
/// process instead of a browser context: no Origin or Sec-Fetch headers, and
/// the same as owl.js otherwise. owl.js documents the index format.
enum OWLResolver {
    struct Result {
        var articleID: String?
        var ranged: Bool  // fetched part of the bucket file rather than all of it
    }

    private struct Config {
        var group: Int
        var bucketCount: Int
        var hashLength: Int
    }

    private struct LookupError: Error {
        var message: String
    }

    private static let base = "https://news-assets.apple.com/owl-bucket-groups/"
    private static let window = 48 * 1024
    private static var sizeGuess = 531_000.0  // bucket files run 518–544 KB; refined by each response
    private static var config: Config?

    /// The Apple News article ID for a web URL, or nil if News has none.
    static func resolve(_ url: String) async throws -> Result {
        guard let canonical = canonicalize(url) else { return Result(articleID: nil, ranged: false) }

        let config = try await loadConfig()
        let hash = Array(SHA256.hash(data: Data(canonical.utf8)).prefix(config.hashLength))
        var bucket = 0
        for byte in hash.reversed() {  // little-endian integer, mod bucketCount
            bucket = (bucket * 256 + Int(byte)) % config.bucketCount
        }
        let path = "\(config.group)/index/\(bucket)"

        do {
            return Result(articleID: try await lookupRanged(path, hash: hash), ranged: true)
        } catch {
            return Result(articleID: try await lookupFull(path, hash: hash), ranged: false)
        }
    }

    // MARK: Canonicalization

    /// Mirrors NBURLCanonicalizer, like owlCanonicalize in owl.js.
    static func canonicalize(_ input: String) -> String? {
        let pattern = try! NSRegularExpression(pattern: "^([a-z][a-z0-9+.-]*)://([^/?#]*)([^?#]*)", options: .caseInsensitive)
        let ns = input as NSString
        guard let m = pattern.firstMatch(in: input, range: NSRange(location: 0, length: ns.length)) else { return nil }
        let scheme = ns.substring(with: m.range(at: 1)).lowercased()
        let authority = ns.substring(with: m.range(at: 2))
            .replacingOccurrences(of: ":[^@]*@", with: "@", options: .regularExpression)
            .lowercased()

        var encoded: [UInt8] = []
        for scalar in ns.substring(with: m.range(at: 3)).unicodeScalars {
            if scalar.isASCII {
                encoded.append(UInt8(scalar.value))
            } else {
                for byte in String(scalar).utf8 { encoded += Array(String(format: "%%%02X", byte).utf8) }
            }
        }

        var path = ""
        var i = 0
        while i < encoded.count {
            if encoded[i] == UInt8(ascii: "%"), i + 2 < encoded.count,
               let value = UInt8(String(decoding: encoded[i + 1...i + 2], as: UTF8.self), radix: 16) {
                path += isUnreserved(value) ? String(UnicodeScalar(value)) : String(format: "%%%02X", value)
                i += 3
            } else {
                path.append(Character(UnicodeScalar(encoded[i])))
                i += 1
            }
        }
        if path.hasSuffix("/") { path.removeLast() }
        return "\(scheme)://\(authority)\(path)"
    }

    private static func isUnreserved(_ c: UInt8) -> Bool {
        (0x41...0x5A).contains(c) || (0x61...0x7A).contains(c) || (0x30...0x39).contains(c) || "-._~".utf8.contains(c)
    }

    // MARK: Protobuf

    private enum Value {
        case varint(Int)
        case bytes(ArraySlice<UInt8>)
    }

    private static func varint(_ b: ArraySlice<UInt8>, _ i: inout Int) -> Int? {
        var result = 0, shift = 0
        while i < b.endIndex, shift <= 56 {
            let byte = b[i]
            i += 1
            result |= Int(byte & 0x7F) << shift
            if byte & 0x80 == 0 { return result }
            shift += 7
        }
        return nil
    }

    private static func fields(_ b: ArraySlice<UInt8>) -> [(Int, Value)] {
        var out: [(Int, Value)] = []
        var i = b.startIndex
        while i < b.endIndex, let key = varint(b, &i) {
            switch key & 7 {
            case 0:
                guard let v = varint(b, &i) else { return out }
                out.append((key >> 3, .varint(v)))
            case 2:
                guard let len = varint(b, &i), i + len <= b.endIndex else { return out }
                out.append((key >> 3, .bytes(b[i..<i + len])))
                i += len
            case 1: i += 8
            case 5: i += 4
            default: return out
            }
        }
        return out
    }

    private static func bytesField(_ b: ArraySlice<UInt8>, _ field: Int) -> ArraySlice<UInt8>? {
        for case let (f, .bytes(v)) in fields(b) where f == field { return v }
        return nil
    }

    /// The article ID in an index entry ({ 1: hash, 2: { 1: articleID, 2: storefront } }).
    private static func articleID(inEntry entry: ArraySlice<UInt8>) -> String? {
        bytesField(entry, 2).flatMap { bytesField($0, 1) }.map { String(decoding: $0, as: UTF8.self) }
    }

    // MARK: Fetching

    #if NEWS_CLIENT_HEADERS
    static let sendsNewsHeaders = true

    /// The headers NewsCore sends with these requests, filled in the way it fills
    /// them from News's Info.plist (traced with research/trace-resolver.m). Only
    /// builds you install yourself set NEWS_CLIENT_HEADERS; Release builds,
    /// including App Store archives, don't contain this code.
    private static let newsHeaders: [String: String] = {
        #if os(macOS)
        let newsApp = "/System/Applications/News.app/Contents/Info.plist"
        let newsCore = "/System/Library/PrivateFrameworks/NewsCore.framework/Resources/Info.plist"
        let osName = "macOS"
        #else
        let newsApp = "/Applications/News.app/Info.plist"
        let newsCore = "/System/Library/PrivateFrameworks/NewsCore.framework/Info.plist"
        let osName = "iPhone OS"
        #endif
        let app = NSDictionary(contentsOfFile: newsApp)
        let core = NSDictionary(contentsOfFile: newsCore)
        // Fallbacks are macOS 27.0's News, for when the sandbox can't read the plists.
        let version = app?["CFBundleShortVersionString"] as? String ?? "12.0"
        let build = app?["CFBundleVersion"] as? String ?? "5934.0.2"
        let coreVersion = core?["CFBundleShortVersionString"] as? String ?? "12.0"

        let os = ProcessInfo.processInfo.operatingSystemVersion
        let osVersion = "\(os.majorVersion).\(os.minorVersion)" + (os.patchVersion > 0 ? ".\(os.patchVersion)" : "")
        return [
            "User-Agent": "AppleNews/\(build) Version/\(version)",
            "X-MMe-Client-Info": "<\(sysctl("hw.model") ?? "")> <\(osName);\(osVersion);\(sysctl("kern.osversion") ?? "")> <com.apple.newscore/\(coreVersion) (com.apple.news/\(version))>"
        ]
    }()

    private static func sysctl(_ name: String) -> String? {
        #if os(iOS)
        if name == "hw.model" {  // on iOS hw.model is the board; the machine name is the model
            var info = utsname()
            uname(&info)
            return withUnsafeBytes(of: &info.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
        }
        #endif
        var size = 0
        guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return nil }
        var buffer = [CChar](repeating: 0, count: size)
        guard sysctlbyname(name, &buffer, &size, nil, 0) == 0 else { return nil }
        return String(cString: buffer)
    }
    #else
    static let sendsNewsHeaders = false
    #endif

    private static func fetch(_ path: String, range: ClosedRange<Int>? = nil) async throws -> (bytes: [UInt8], start: Int, total: Int?) {
        var request = URLRequest(url: URL(string: base + path)!)
        if let range { request.setValue("bytes=\(range.lowerBound)-\(range.upperBound)", forHTTPHeaderField: "Range") }
        #if NEWS_CLIENT_HEADERS
        for (name, value) in newsHeaders { request.setValue(value, forHTTPHeaderField: name) }
        request.setValue(UUID().uuidString, forHTTPHeaderField: "X-Apple-Request-UUID")
        #endif
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw LookupError(message: "\(path): HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)")
        }
        let bytes = [UInt8](data)
        guard range != nil, http.statusCode == 206 else { return (bytes, 0, bytes.count) }
        let total = http.value(forHTTPHeaderField: "Content-Range")?.split(separator: "/").last.flatMap { Int($0) }
        return (bytes, range!.lowerBound, total)
    }

    private static func loadConfig() async throws -> Config {
        if let config { return config }
        let bytes = try await fetch("currentBucketGroupConfig").bytes
        guard let inner = bytesField(bytes[...], 1) else { throw LookupError(message: "bad config") }
        var values: [Int: Int] = [:]
        for case let (f, .varint(v)) in fields(inner) { values[f] = v }
        guard let group = values[1], let count = values[2], count > 0, let length = values[3] else {
            throw LookupError(message: "bad config")
        }
        let loaded = Config(group: group, bucketCount: count, hashLength: length)
        config = loaded
        return loaded
    }

    // MARK: Lookups

    private static func lookupFull(_ path: String, hash: [UInt8]) async throws -> String? {
        let bytes = try await fetch(path).bytes
        for case (2, .bytes(let entry)) in fields(bytes[...]) where bytesField(entry, 1).map(Array.init) == hash {
            return articleID(inEntry: entry)
        }
        return nil
    }

    private struct Entry {
        var offset: Int
        var end: Int
        var hash: [UInt8]
        var entry: ArraySlice<UInt8>
    }

    /// The complete entries in a slice that may begin and end mid-entry; see owlSliceEntries.
    private static func sliceEntries(_ b: [UInt8], hashLength: Int) -> [Entry] {
        func header(_ i: Int) -> (body: Int, end: Int)? {
            guard i < b.count, b[i] == 0x12 else { return nil }
            var j = i + 1
            guard let len = varint(b[...], &j), j + 1 < b.count, b[j] == 0x0A, Int(b[j + 1]) == hashLength else { return nil }
            return (j, j + len)
        }
        func isBoundary(_ start: Int) -> Bool {
            var i = start
            for n in 0..<3 {
                if i >= b.count { return true }
                guard let h = header(i) else { return n > 0 && i > b.count - 16 }
                i = h.end
            }
            return true
        }

        var i = 0
        while i < b.count, !isBoundary(i) { i += 1 }
        var entries: [Entry] = []
        while let h = header(i), h.end <= b.count, h.body + 2 + hashLength <= h.end {
            entries.append(Entry(offset: i, end: h.end, hash: Array(b[h.body + 2..<h.body + 2 + hashLength]), entry: b[h.body..<h.end]))
            i = h.end
        }
        return entries
    }

    private static func lookupRanged(_ path: String, hash: [UInt8]) async throws -> String? {
        let share = Double(UInt32(hash[0]) << 24 | UInt32(hash[1]) << 16 | UInt32(hash[2]) << 8 | UInt32(hash[3])) / 4_294_967_296
        var start = max(0, Int((share * sizeGuess).rounded()) - window / 2)
        var end = start + window - 1

        for _ in 0..<4 {
            let slice = try await fetch(path, range: start...end)
            if let total = slice.total { sizeGuess = (sizeGuess * 3 + Double(total)) / 4 }

            let entries = sliceEntries(slice.bytes, hashLength: hash.count)
            guard let first = entries.first, let last = entries.last else { break }
            let atStart = slice.start == 0
            let atEnd = slice.start + slice.bytes.count >= (slice.total ?? .max) || slice.bytes.count < end - start + 1

            if hash.lexicographicallyPrecedes(first.hash), !atStart {
                end = slice.start + first.offset - 1
                start = max(0, end + 1 - window)
            } else if last.hash.lexicographicallyPrecedes(hash), !atEnd {
                start = slice.start + last.end
                end = start + window - 1
            } else {
                return entries.first { $0.hash == hash }.flatMap { articleID(inEntry: $0.entry) }
            }
        }
        throw LookupError(message: "range lookup did not converge")  // resolve falls back to the whole file
    }
}
