# Open in News for iOS

A Safari extension for iPhone and iPad that opens paywalled publisher articles (WSJ, The Atlantic,
The New Yorker, WIRED…) in the Apple News app, where an Apple News+ subscription covers them.

It needs no private APIs and no server. It works by reproducing, in about 100 lines of JavaScript,
the lookup that macOS News uses to turn a web URL into a News article.

## How it works

1. A content script reports each page you load to the extension's background script.
2. If the page is on a site you've turned on and its URL ends in an article slug, the extension
   looks the URL up in Apple's public "open web links" index ([`owl.js`](Extension/Resources/owl.js)).
3. On a hit, the page opens `applenewss:///<articleID>`, and a pill linking to
   `https://apple.news/<articleID>` appears at the bottom of the page. A miss means News doesn't
   have the article, so nothing happens.

On a phone, the lookup takes one ~500 KB download from Apple's CDN and feels instant.

## The lookup

News publishes a k-anonymous index of web URL → article ID on a public CDN. Nothing identifies the
user, and the URL never leaves the device. The client downloads one of 13,000 buckets, so the
server learns only which bucket was requested, not which of its ~9,000 entries the client wanted.

| Step | Detail |
| --- | --- |
| Config | `GET https://news-assets.apple.com/owl-bucket-groups/currentBucketGroupConfig` returns protobuf `{1: {1: group, 2: bucketCount, 3: hashLength}}`, currently group 2, 13000 buckets, 15 bytes |
| Canonicalize | Lowercase the scheme and host; drop the query and fragment; strip one trailing slash; decode percent-escapes of unreserved characters (`%2D` → `-`). Path case, ports, `www.` and dot segments are kept. |
| Hash | `SHA-256(canonical URL)`, truncated to `hashLength` bytes |
| Bucket | The hash read as a **little-endian** integer, mod `bucketCount` |
| Index | `GET …/owl-bucket-groups/<group>/index/<bucket>` returns protobuf with repeated field 2 `{1: hash, 2: {1: articleID, 2: storefront}}`, sorted by hash |
| Open | `applenewss:///<articleID>` or the universal link `https://apple.news/<articleID>` |

The files are served with `Access-Control-Allow-Origin: *` and support range requests. The
storefront field (`143441` is the US, `143455` Canada) does not restrict the lookup; macOS News
returns the article ID regardless.

## How it was found

The [`yerinle/news_ext`](https://github.com/yerinle/news_ext) project opens News+ articles from
Safari and Chrome on macOS by handing URLs to the system **Open in News** share service. Its notes
conclude that iOS is impossible: the same share extension ships on iOS but is disabled
(`NSExtensionActivationRule = FALSEPREDICATE`), and the `applenews://` scheme only opens News to
Today unless you already have an article ID. The question here was where macOS gets that ID.

1. **The share extension.** `strings` on
   `/System/Applications/News.app/Contents/PlugIns/OpenInNews.appex/Contents/MacOS/OpenInNews`
   shows the flow in its selectors: `resolveWebURL:withQualityOfService:completion:` produces an
   article ID, `nss_NewsURLForArticleID:…` builds a News URL, and `LSApplicationWorkspace`
   `openURL:` opens it. The resolution itself lives in a framework.
2. **Finding the resolver.** Loading the private `NewsCore` framework and walking the Objective-C
   runtime for classes that implement that selector turns up exactly one:
   `FCWebURLResolutionEndpointConnection`. Its ivars (`NBURLCanonicalizer`, `NBURLHasher`,
   `NBHashBucketer`) and methods (`_hashOfURLWithWebURL:config:`,
   `_fetchListsPromiseWithConfig:…hash:…`, `_articleIDWithHash:lists:storeFrontID:`) describe a
   hash-bucket lookup.
3. **Watching it run.** [`research/trace-resolver.m`](research/trace-resolver.m) builds the
   resolver with News's own configuration manager, swizzles `NSURLSessionTask -resume` to log every
   request, and resolves a URL. Out come the config and index endpoints above, with no
   authentication.
4. **Recovering the algorithm.** The `NB*` classes in `NewsURLBucket.framework` can be called
   directly, so they were treated as a black box. The canonicalizer's output for a set of edge-case
   URLs gives the rules ([`research/canonicalize.m`](research/canonicalize.m)). The hasher's output
   matched plain SHA-256. The bucketer's output for a range of bucket counts matched
   the little-endian hash mod n, and the bucket a real lookup requested (12591) confirmed it.
5. **Decoding the index.** The bucket files are plain protobuf, readable with a 20-line varint
   parser.
6. **Checking it.** `owl.js` returns the same article IDs as macOS News's own resolver, and matches
   its canonicalizer on every edge case tested. Current WSJ, Atlantic, New Yorker and WIRED articles
   resolve; section fronts and affiliate pages don't. Spot-checked `apple.news/<id>` pages point back to the
   original article.

Apple's `open-web-links/domainBloomFilter` was also examined. It flags so many unrelated domains
that it isn't useful as a pre-check, so the extension uses a site list instead.

## Install

Requires Xcode, [XcodeGen](https://github.com/yonaskolb/XcodeGen) and iOS 26 or later.

```sh
brew install xcodegen
xcodegen generate
open OpenInNews.xcodeproj
```

Set your own team in `project.yml` (`DEVELOPMENT_TEAM`) and bundle IDs, then run the
**OpenInNews** scheme on your device. Then:

1. **Settings › Apps › Safari › Extensions › Open in News**: turn it on.
2. Allow it on the publishers you read, or on all websites.

## Using it

- **Sites.** [`sites.js`](Extension/Resources/sites.js) seeds paywalled publishers whose articles
  resolve. Add or remove any site from the extension's menu in Safari's address bar (*Use on …*).
- **Automatic opening** is on by default and can be turned off in the same menu. The pill at the
  bottom of the page still appears. After opening a URL automatically, the extension leaves that
  URL alone for 15 minutes, so you can come back to the web version.
- **Any page.** *Open in News* in the menu looks up whatever page you're on, on any site.

To check whether News carries a site before adding it:

```sh
node scripts/check-site.js economist.com ft.com
```

It resolves up to 12 article links from the site's homepage and reports how many News has. Sites
that block automated requests report 0/0.

## Layout

```
App/                      Host app: setup instructions
Extension/
  SafariWebExtensionHandler.swift   Required principal class; does nothing
  Resources/
    owl.js                Apple News URL resolver (also runs in Node)
    background.js         Site settings, lookups, auto-open cooldown
    content.js            Per-page check, auto-open and the pill
    popup.html, popup.js  Address-bar menu
    sites.js              Seed site list
research/                 macOS tools used to recover the lookup
scripts/
  check-site.js           Measures how much of a site News carries
  make-icons.swift        Draws the icons
```

## Limitations

- **Undocumented.** Apple can change the bucket layout, hash or canonicalization at any time. The
  config file carries the bucket count and hash length, but a change to the algorithm would need an
  update here.
- **A site list, not News+ membership.** News carries plenty of free publishers too. The seed list
  is paywalled publishers only, so free articles aren't sent to News without you asking.
- **Single-page apps.** Pages are checked when they load, so articles a site opens without a full
  page load are missed. Use the menu button for those.

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md). You can use, change and share this code, including in
your own apps, for any noncommercial purpose. Selling it, or using it in a commercial product or
service, isn't permitted.
