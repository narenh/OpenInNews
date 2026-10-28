import SafariServices

/// Safari requires a principal class, but the iOS extension needs no native code:
/// owl.js resolves articles from Apple's public index and the page opens News itself.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        context.completeRequest(returningItems: nil)
    }
}
