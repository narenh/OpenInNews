import SwiftUI

@main
struct OpenInNewsApp: App {
    var body: some Scene {
        WindowGroup {
            SetupView()
        }
    }
}

struct SetupView: View {
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Articles from paywalled publishers open in the Apple News app, where your News+ subscription covers them.")
                }
                Section("Turn it on") {
                    Label("Open Settings › Apps › Safari › Extensions", systemImage: "1.circle")
                    Label("Tap Open in News and turn it on", systemImage: "2.circle")
                    Label("Allow it on the publishers you read", systemImage: "3.circle")
                }
                Section("Using it") {
                    Text("On a supported site, articles that are in News open there automatically, or tap Open in News at the bottom of the page. Use the extension’s menu in the address bar to add a site or turn automatic opening off.")
                }
                Section {
                    Text("Lookups use Apple’s public News index and never leave your device as a URL. There is no server and no analytics.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Open in News")
        }
    }
}
