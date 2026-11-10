import SafariServices
import SwiftUI

@main
struct OpenInNewsApp: App {
    var body: some Scene {
        WindowGroup {
            StatusView()
            #if os(macOS)
                .frame(minWidth: 440, idealWidth: 480, minHeight: 520, idealHeight: 640)
            #endif
        }
        #if os(macOS)
        .windowResizability(.contentSize)
        #endif
    }
}

// MARK: - Model

@Observable
final class StatusModel {
    /// nil when iOS can't say (before 26.2).
    var extensionEnabled: Bool?
    var status: ExtensionStatus?
    var syncedAt: Date?
    /// Bumped when the app edits the site modes, so views that read them update.
    var modesRevision = 0

    func refresh() async {
        #if os(macOS)
        extensionEnabled = try? await SFSafariExtensionManager.stateOfSafariExtension(withIdentifier: SharedStatus.extensionID).isEnabled
        #else
        if #available(iOS 26.2, *) {
            extensionEnabled = try? await SFSafariExtensionManager.stateOfExtension(withIdentifier: SharedStatus.extensionID).isEnabled
        }
        #endif
        let shared = SharedStatus.load()
        status = shared?.status
        syncedAt = shared?.syncedAt
        modesRevision += 1
    }
}

/// A site counts as reachable if the extension ran there recently, which it
/// can only do once you've allowed it on that site.
private let recentlySeen: TimeInterval = 30 * 24 * 3600

// MARK: - Lights

enum Light {
    case green, yellow, red, off

    var color: Color {
        switch self {
        case .green: .green
        case .yellow: .yellow
        case .red: .red
        case .off: .gray.opacity(0.45)
        }
    }
}

struct StatusLight: View {
    let light: Light

    var body: some View {
        Circle()
            .fill(light.color.gradient)
            .frame(width: 14, height: 14)
            .shadow(color: light == .off ? .clear : light.color.opacity(0.7), radius: 5)
    }
}

struct StatusRow<Detail: View>: View {
    let light: Light
    let title: String
    @ViewBuilder let detail: Detail

    var body: some View {
        HStack(spacing: 14) {
            StatusLight(light: light)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                detail
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Screen

struct StatusView: View {
    @State private var model = StatusModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    extensionRow
                    if SharedStatus.isAvailable {
                        accessRow
                        lookupRow
                    }
                } footer: {
                    if !SharedStatus.isAvailable {
                        Text("This build was signed without its app group, so it can’t show the extension’s settings.")
                    }
                }
                if SharedStatus.isAvailable {
                    sitesLink
                }
                if !allGreen {
                    setupSection
                }
                Section {
                    Text("Lookups use Apple’s public News index; the URLs you read never leave your device. There is no server and no analytics.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Auto Open in News")
            .refreshable { await model.refresh() }
        }
        .task(id: scenePhase) {
            if scenePhase == .active { await model.refresh() }
        }
    }

    @ViewBuilder
    private var extensionRow: some View {
        switch model.extensionEnabled {
        case true?:
            StatusRow(light: .green, title: "Safari extension") { Text("On") }
        case false?:
            StatusRow(light: .red, title: "Safari extension") { Text("Off — turn it on in Safari’s settings") }
        case nil:
            StatusRow(light: .off, title: "Safari extension") { Text("iOS can’t report this before 26.2") }
        }
        Button("Open Safari Extension Settings") {
            openExtensionSettings()
        }
    }

    /// Opens Safari's settings at this extension: on/off, and its website access.
    private func openExtensionSettings() {
        #if os(macOS)
        SFSafariApplication.showPreferencesForExtension(withIdentifier: SharedStatus.extensionID)
        #else
        if #available(iOS 26.2, *) {
            SFSafariSettings.openExtensionsSettings(forIdentifiers: [SharedStatus.extensionID])
        } else if let url = URL(string: UIApplication.openSettingsURLString) {
            UIApplication.shared.open(url)
        }
        #endif
    }

    private var reachableSites: [String] {
        guard let status = model.status else { return [] }
        return model.allSites.filter { site in
            model.mode(site) != .off && (status.lastSeen(site).map { -$0.timeIntervalSinceNow < recentlySeen } ?? false)
        }
    }

    @ViewBuilder
    private var accessRow: some View {
        if model.extensionEnabled == false {
            StatusRow(light: .red, title: "Website access") { Text("Needs the extension turned on") }
        } else if model.status == nil {
            StatusRow(light: .yellow, title: "Website access") { Text("Not reported yet — open a publisher’s article in Safari") }
        } else if reachableSites.isEmpty {
            StatusRow(light: .yellow, title: "Website access") { Text("Not seen on any site yet — allow it when Safari asks") }
        } else {
            let on = model.allSites.filter { model.mode($0) != .off }.count
            StatusRow(light: .green, title: "Website access") { Text("Working on \(reachableSites.count) of \(on) sites") }
        }
    }

    @ViewBuilder
    private var lookupRow: some View {
        if let lookup = model.status?.lastLookup {
            let at = Date(timeIntervalSince1970: lookup.at / 1000)
            StatusRow(light: lookup.ranged ? .green : .yellow, title: "Last lookup") {
                Text("\(Int(lookup.ms)) ms · \(lookup.ranged ? "partial" : "whole") index download\(lookup.native == true ? " by the app extension" : " by Safari")\(lookup.newsHeaders == true ? " as News" : "") · \(at, format: .relative(presentation: .named))")
            }
        }
    }

    private var sitesLink: some View {
        Section {
            NavigationLink {
                SitesView(model: model)
            } label: {
                LabeledContent("Sites", value: model.modes == nil ? "Not reported yet" : model.summary)
            }
        } footer: {
            if let syncedAt = model.syncedAt {
                Text("Reported by Safari \(syncedAt, format: .relative(presentation: .named)).")
            }
        }
    }

    private var allGreen: Bool {
        model.extensionEnabled != false && (!reachableSites.isEmpty || !SharedStatus.isAvailable)
    }

    private var setupSection: some View {
        Section("Set up") {
            #if os(macOS)
            Label("Open Safari › Settings › Extensions", systemImage: "1.circle")
            Label("Tick Auto Open in News", systemImage: "2.circle")
            #else
            Label("Tap Open Safari Extension Settings above", systemImage: "1.circle")
            Label("Turn Auto Open in News on", systemImage: "2.circle")
            #endif
            Label("Open a publisher’s article in Safari and allow the extension there", systemImage: "3.circle")
        }
    }
}
