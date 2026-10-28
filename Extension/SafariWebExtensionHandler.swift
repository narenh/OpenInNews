import SafariServices
#if os(macOS)
import AppKit
#endif

/// Native side of the Safari extension. Stores the settings background.js
/// reports, for the app to show, and on the Mac opens articles in News without
/// Safari's "Open in News?" prompt.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message = item?.userInfo?[SFExtensionMessageKey] as? [String: Any] ?? [:]
        var reply: [String: Any] = [:]

        switch message["action"] as? String {
        case "sync":
            if let state = message["state"] {
                SharedStatus.save(state)
            }
        case "open":
            reply["opened"] = open(articleID: message["id"] as? String)
        default:
            break
        }

        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: reply]
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
