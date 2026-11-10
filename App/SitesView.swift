import SwiftUI

/// The site list the extension works from: the built-in sites plus any you add.
/// A site missing from the modes is off.
extension StatusModel {
    /// The extension's modes or the app's edit of them, whichever changed last.
    /// nil until the extension has reported its sites, so an edit can't replace
    /// settings the app hasn't seen.
    var modes: [String: SiteMode]? {
        _ = modesRevision // the app's edits live in storage; reading this keeps views watching them
        let fromSafari = status?.modes.map { $0.compactMapValues(SiteMode.init(rawValue:)) }
        let safariAt = status?.modesAt ?? 0
        if let app = SharedStatus.loadModes(), app.at > safariAt || fromSafari == nil { return app.modes }
        return fromSafari
    }

    func mode(_ site: String) -> SiteMode { modes?[site] ?? .off }

    /// Sites you added: in the modes but not built in.
    var customSites: [String] { (modes ?? [:]).keys.filter { !seedSites.contains($0) }.sorted() }

    /// Built-in sites and the ones you added, alphabetically.
    var allSites: [String] { Set(seedSites).union(customSites).sorted() }

    /// Sites the extension has run on, newest first.
    var visitedSites: [String] {
        let known = Set(allSites)
        return (status?.seen ?? [:]).filter { known.contains($0.key) }.sorted { $0.value > $1.value }.map(\.key)
    }

    var summary: String {
        let counts = allSites.reduce(into: [SiteMode: Int]()) { $0[mode($1), default: 0] += 1 }
        let parts = [(counts[.auto], "auto"), (counts[.ask], "ask")].compactMap { n, name in n.map { "\($0) \(name)" } }
        return parts.isEmpty ? "None on" : parts.joined(separator: ", ")
    }

    func set(_ site: String, _ mode: SiteMode) {
        guard var next = modes else { return }
        next[site] = mode
        write(next)
    }

    func setAll(_ mode: SiteMode) {
        guard var next = modes else { return }
        for site in allSites { next[site] = mode }
        write(next)
    }

    func remove(_ site: String) {
        guard var next = modes, !seedSites.contains(site) else { return }
        next[site] = nil
        write(next)
    }

    private func write(_ modes: [String: SiteMode]) {
        SharedStatus.saveModes(modes)
        modesRevision += 1 // modes is computed from storage; this makes views read it again
    }

    /// A pasted URL or host as a bare lowercase host without "www.", or nil if it isn't one.
    static func site(from text: String) -> String? {
        var text = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if let scheme = text.range(of: "://") { text = String(text[scheme.upperBound...]) }
        text = String(text.prefix { !"/?#".contains($0) })
        if let at = text.lastIndex(of: "@") { text = String(text[text.index(after: at)...]) }
        text = String(text.prefix { $0 != ":" })
        if text.hasPrefix("www.") { text = String(text.dropFirst(4)) }
        let labels = text.split(separator: ".", omittingEmptySubsequences: false)
        let valid = labels.count >= 2 && labels.allSatisfy { label in
            !label.isEmpty && !label.hasPrefix("-") && !label.hasSuffix("-") && label.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
        }
        return valid ? text : nil
    }

    func add(_ text: String) -> Bool {
        guard let site = Self.site(from: text), var next = modes else { return false }
        next[site] = .auto
        write(next)
        return true
    }
}

struct SitesView: View {
    let model: StatusModel
    @State private var newSite = ""
    @State private var confirmAll = false

    var body: some View {
        List {
            if model.modes == nil {
                Section {
                    Text(SharedStatus.isAvailable
                         ? "Safari hasn’t reported its sites yet. Open a page in Safari, then pull down to refresh."
                         : "This build was signed without its app group, so it can’t edit the extension’s sites.")
                        .foregroundStyle(.secondary)
                }
            } else {
                Section {
                    HStack {
                        TextField("Add site", text: $newSite, prompt: Text("example.com"))
                            .autocorrectionDisabled()
                        #if os(iOS)
                            .textInputAutocapitalization(.never)
                            .keyboardType(.URL)
                        #endif
                            .onSubmit(add)
                        Button("Add", action: add)
                            .disabled(StatusModel.site(from: newSite) == nil)
                    }
                }
                if !model.visitedSites.isEmpty {
                    Section("Visited") {
                        ForEach(model.visitedSites, id: \.self) { row($0, showSeen: true) }
                    }
                }
                Section {
                    ForEach(model.allSites, id: \.self) { row($0, showSeen: false) }
                } header: {
                    Text("All sites")
                } footer: {
                    Text("Off: not checked. Ask: shows the Open in News button, never opens News by itself. Auto: opens News by itself. Changes reach Safari the next time it finds an article.")
                }
            }
        }
        .navigationTitle("Sites")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            if model.modes != nil {
                ToolbarItem {
                    Menu("More", systemImage: "ellipsis.circle") {
                        Button("Set all to Auto") { confirmAll = true }
                    }
                }
            }
        }
        .confirmationDialog("Set every site to Auto?", isPresented: $confirmAll, titleVisibility: .visible) {
            Button("Set all to Auto") { model.setAll(.auto) }
        } message: {
            Text("News will open by itself on every built-in site and every site you added.")
        }
        .refreshable { await model.refresh() }
    }

    private func add() {
        if model.add(newSite) { newSite = "" }
    }

    private func row(_ site: String, showSeen: Bool) -> some View {
        let custom = !seedSites.contains(site)
        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(site)
                Spacer()
                if showSeen, let seen = model.status?.lastSeen(site) {
                    Text(seen, format: .relative(presentation: .named))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            Picker(site, selection: Binding(get: { model.mode(site) }, set: { model.set(site, $0) })) {
                ForEach(SiteMode.allCases) { Text($0.title) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .font(.footnote)
        }
        .padding(.vertical, 2)
        .swipeActions {
            if custom {
                Button("Delete", role: .destructive) { model.remove(site) }
            }
        }
        .contextMenu {
            if custom {
                Button("Delete", role: .destructive) { model.remove(site) }
            }
        }
    }
}
