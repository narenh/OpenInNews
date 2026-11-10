import SafariServices
#if os(macOS)
import AppKit
#endif

/// Native side of the Safari extension. Looks up articles from the extension's
/// own process (see OWLResolver), stores the settings background.js reports for
/// the app to show, and on the Mac opens articles in News without Safari's
/// "Open in News?" prompt.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message = item?.userInfo?[SFExtensionMessageKey] as? [String: Any] ?? [:]

        switch message["action"] as? String {
        case "resolve":
            let url = message["url"] as? String ?? ""
            Task {
                do {
                    let result = try await OWLResolver.resolve(url)
                    Self.reply(context, ["found": result.articleID != nil, "id": result.articleID ?? "", "ranged": result.ranged,
                                         "newsHeaders": OWLResolver.sendsNewsHeaders])
                } catch {
                    Self.reply(context, ["error": String(describing: error)])
                }
            }
        case "sync":
            let state = message["state"] as? [String: Any]
            if let state {
                SharedStatus.save(state)
            }
            Self.reply(context, Self.appModes(newerThan: state?["modesAt"] as? Double))
        case "pull":
            Self.reply(context, Self.appModes(newerThan: message["modesAt"] as? Double))
        case "open":
            Self.reply(context, ["opened": open(articleID: message["id"] as? String)])
        default:
            Self.reply(context, [:])
        }
    }

    /// The modes as edited in the app, only if newer than the extension's copy
    /// (`modesAt`, ms since 1970); background.js keeps them if they're newer still.
    private static func appModes(newerThan modesAt: Double?) -> [String: Any] {
        guard let app = SharedStatus.loadModes(), app.at > (modesAt ?? 0) else { return [:] }
        return ["modes": app.modes.mapValues(\.rawValue), "modesAt": app.at]
    }

    private static func reply(_ context: NSExtensionContext, _ message: [String: Any]) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: message]
        context.completeRequest(returningItems: [response])
    }

    private func open(articleID: String?) -> Bool {
        #if os(macOS)
        guard let id = articleID,
              id.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }),
              let url = URL(string: "applenewss:///\(id)") else { return false }
        return NSWorkspace.shared.open(url)
        #else
        return false // iOS extensions can't open URLs; the page does it instead
        #endif
    }
}
