# Open in News

Browser extensions for Safari (iPhone, iPad and Mac) and Chrome (Mac) that open paywalled publisher
articles (WSJ, The Atlantic, The New Yorker, WIRED…) in the Apple News app, where an Apple News+
subscription covers them.

It needs no private APIs and no server. It works by reproducing the lookup that macOS News uses to
turn a web URL into a News article: in Swift for Safari, and in JavaScript for Chrome.

## How it works

1. A content script reports each page you load to the extension's background script.
2. If the page is on a site you've turned on and its URL ends in an article slug, the extension
   looks the URL up in Apple's public "open web links" index. In Safari the app extension's native
   code does this ([`OWLResolver.swift`](Extension/OWLResolver.swift)), so the request doesn't come
   from a browser context; Chrome, and Safari if that fails, use [`owl.js`](Extension/Resources/owl.js).
3. On a hit, News opens the article (if automatic opening is on) and an *Open in News* pill appears
   at the bottom of the page. A miss means News doesn't have the article, so nothing happens.

The web extension is shared by every browser. Safari adds native code for the lookup and, on the Mac,
for opening News. How News opens:

| Browser | How News opens |
| --- | --- |
| Safari, iPhone and iPad | The page navigates to `applenewss:///<articleID>`. The pill links to `https://apple.news/<articleID>`, a universal link that opens News directly when tapped. |
| Safari, Mac | The extension's native handler opens `applenewss:///<articleID>` with `NSWorkspace`, so Safari doesn't ask first. |
| Chrome, Mac | The page navigates to `applenewss:///<articleID>`. Chrome asks before opening News, with an option to always allow it for that site. |

Each lookup downloads about 48 KB from Apple's CDN (see [Partial downloads](#partial-downloads)).

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

### Partial downloads

A bucket file is about 530 KB, but its entries are sorted by hash and the hashes are uniformly
distributed, so a hash's share of the hash space predicts where its entry sits. `owl.js` requests a
48 KB range centred on that spot. Over 440 test lookups (hits, misses, and the first and last entry
of several files) every one was answered by that first range; if one isn't, the next range over is
fetched. If range requests fail, it downloads the whole file instead.

Cold lookups (HTTP cache off) from an extension page in Chromium, with DevTools network throttling,
median of five URLs:

| Connection | Whole file (515 KB) | Range (48 KB) | Faster by |
| --- | --- | --- | --- |
| Wi-Fi, no throttling | 109 ms | 6 ms | 18× |
| 20 Mbps, 40 ms latency | 268 ms | 70 ms | 3.8× |
| 5 Mbps, 100 ms | 956 ms | 193 ms | 5.0× |
| 1.5 Mbps, 300 ms | 3.1 s | 0.58 s | 5.3× |
| 400 kbps, 500 ms | 11.0 s | 1.5 s | 7.2× |

The CDN rejects CORS preflights. Extension contexts with host permission don't send one, but an
ordinary web page in Chromium does, so the same code run from a page falls back to the whole file.
Safari's native lookups aren't subject to CORS at all. The status app's *Last lookup* row shows how
the last lookup was made.

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

### Safari (iPhone, iPad, Mac)

Requires Xcode and [XcodeGen](https://github.com/yonaskolb/XcodeGen); iOS 26 or macOS 14 or later.

```sh
brew install xcodegen
xcodegen generate
open OpenInNews.xcodeproj
```

Set your own team (`DEVELOPMENT_TEAM`), bundle IDs and app group names in `project.yml` and
[`Shared/SharedStatus.swift`](Shared/SharedStatus.swift).

- **iPhone and iPad:** run the **OpenInNews** scheme on your device, then turn the extension on in
  **Settings › Apps › Safari › Extensions › Auto Open in News** and allow it on the publishers you read.
- **Mac:** run `./scripts/install-mac.sh`, which builds the **OpenInNewsMac** scheme and installs it
  to `/Applications`. Then tick **Auto Open in News** in **Safari › Settings › Extensions** and allow
  it on the publishers you read.

**If Safari keeps turning the extension off:** turn off **Settings › Apps › Safari › Extensions ›
Share Across Devices**. Safari syncs which extensions are on through iCloud, but only for App Store
and TestFlight apps. A build you install yourself can't save its state there, so when Safari
relaunches and applies the iCloud state, it switches the extension off, sometimes after one relaunch,
sometimes after two. With sharing off, it stays on.

The app shows status lights for the extension: whether Safari has it turned on, whether it has run
on your sites, and whether automatic opening is on.

### Builds you install yourself vs. release builds

Safari's native lookups can send the same request headers News sends for them (`User-Agent:
AppleNews/…`, `X-MMe-Client-Info`), so the CDN can't block this extension without blocking News. That
code is compiled in only with the `NEWS_CLIENT_HEADERS` Swift flag:

- **Debug builds** (running from Xcode) set it.
- **`scripts/install-mac.sh`** sets it for its Release build.
- **Other Release builds**, including App Store archives, don't, and their binaries contain none of
  it. Those identify as Open in News.

To set it on any other build, pass
`SWIFT_ACTIVE_COMPILATION_CONDITIONS='$(inherited) NEWS_CLIENT_HEADERS'` to `xcodebuild`.

### Chrome (Mac)

```sh
./scripts/build-chrome.sh
```

Then, at `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and select
`build/chrome`. The first time an article opens, tick *Always allow* in Chrome's dialog to skip it
next time. Chrome has no native helper to install.

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
App/                      Status app for iOS and macOS (one SwiftUI source)
Shared/SharedStatus.swift Settings the extension reports to the app, via an app group
Extension/
  SafariWebExtensionHandler.swift   Native lookups, status reports, opening News on the Mac
  OWLResolver.swift       Swift port of owl.js, used by Safari
  Resources/              The web extension, shared by Safari and Chrome
    owl.js                Apple News URL resolver (also runs in Node)
    background.js         Site settings, lookups, auto-open cooldown
    content.js            Per-page check, auto-open and the pill
    popup.html, popup.js  The toolbar / address-bar menu
    sites.js              Seed site list
    compat.js             Maps `browser` to `chrome` in Chrome
Chrome/                   Chrome's manifest and service worker
research/                 macOS tools used to recover the lookup
scripts/
  build-chrome.sh         Assembles build/chrome
  install-mac.sh          Builds and installs the Mac app
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
