/*
 * Resolves a publisher web URL to its Apple News article ID, without Apple code.
 *
 * Reimplements NewsCore's FCWebURLResolutionEndpointConnection ("open web links",
 * OWL), the lookup that macOS's OpenInNews.appex performs. Apple publishes a
 * k-anonymous index on a public CDN (CORS *, no auth):
 *
 *   currentBucketGroupConfig   protobuf { 1: { 1: group, 2: bucketCount, 3: hashLength } }
 *   <group>/index/<bucket>     protobuf { repeated 2: { 1: hash, 2: { 1: articleID, 2: storefront } } }
 *
 *   hash   = SHA-256(canonical URL) truncated to hashLength bytes
 *   bucket = hash read as a little-endian integer, mod bucketCount
 *
 * The article opens with applenewss:///<articleID> (what apple.news/<id> itself
 * redirects to) or the universal link https://apple.news/<articleID>.
 */

const OWL_BASE = 'https://news-assets.apple.com/owl-bucket-groups/';

/*
 * Mirrors NBURLCanonicalizer: lowercase scheme and host, drop the query and
 * fragment, strip one trailing slash, decode percent-escaped unreserved
 * characters. Path case, ports, "www." and dot segments are left alone.
 */
function owlCanonicalize(input) {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i.exec(input);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const authority = m[2].replace(/:[^@]*@/, '@').toLowerCase();
  let path = m[3].replace(/[^\x00-\x7f]+/g, encodeURIComponent).replace(/%([0-9a-f]{2})/gi, (esc, hex) => {
    const c = String.fromCharCode(parseInt(hex, 16));
    return /[A-Za-z0-9\-._~]/.test(c) ? c : '%' + hex.toUpperCase();
  });
  if (path.endsWith('/')) path = path.slice(0, -1);
  return `${scheme}://${authority}${path}`;
}

function* protoFields(bytes) {
  let i = 0;
  const varint = () => {
    let result = 0, shift = 0, b;
    do {
      b = bytes[i++];
      result += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    return result;
  };
  while (i < bytes.length) {
    const key = varint();
    const field = Math.floor(key / 8), wire = key & 7;
    if (wire === 0) yield [field, varint()];
    else if (wire === 2) { const len = varint(); yield [field, bytes.subarray(i, i += len)]; }
    else if (wire === 1) { yield [field, bytes.subarray(i, i += 8)]; }
    else if (wire === 5) { yield [field, bytes.subarray(i, i += 4)]; }
    else throw new Error(`unsupported wire type ${wire}`);
  }
}

async function owlFetch(path) {
  const res = await fetch(OWL_BASE + path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

let owlConfigPromise = null;

function owlConfig() {
  owlConfigPromise ??= owlFetch('currentBucketGroupConfig').then((bytes) => {
    const [[, inner]] = protoFields(bytes);
    const cfg = Object.fromEntries(protoFields(inner));
    return { group: cfg[1], bucketCount: cfg[2], hashLength: cfg[3] };
  }).catch((e) => { owlConfigPromise = null; throw e; });
  return owlConfigPromise;
}

function owlCompare(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/* The article ID in an index entry ({ 1: hash, 2: { 1: articleID, 2: storefront } }). */
function owlEntryID(entry) {
  const e = Object.fromEntries(protoFields(entry));
  return new TextDecoder().decode(Object.fromEntries(protoFields(e[2]))[1]);
}

/* Downloads the whole bucket file (~530 KB) and scans it. */
async function owlLookupFull(path, hash) {
  for (const [field, entry] of protoFields(await owlFetch(path))) {
    if (field !== 2) continue;
    const e = Object.fromEntries(protoFields(entry));
    if (e[1].length === hash.length && owlCompare(e[1], hash) === 0) return owlEntryID(entry);
  }
  return null;
}

/*
 * Bucket files list their entries sorted by hash, and hashes are uniform, so a
 * hash's share of the hash space predicts where its entry sits. A 48 KB window
 * around that spot holds the entry 99% of the time; otherwise the next window
 * over does. That's about a tenth of the bytes of the whole file.
 */
const OWL_WINDOW = 48 * 1024;
let owlSizeGuess = 531000; // bucket files run 518–544 KB; refined by each response

async function owlFetchRange(path, start, end) {
  const res = await fetch(OWL_BASE + path, { headers: { Range: `bytes=${start}-${end}` } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (res.status !== 206) return { bytes, start: 0, total: bytes.length }; // the whole file after all
  const total = Number(res.headers.get('Content-Range')?.split('/')[1]) || null;
  return { bytes, start, total };
}

/*
 * The complete entries in a slice of a bucket file that may begin and end
 * mid-entry. Each entry is field 2 (0x12), a length, then its hash as field 1
 * (0x0a, hashLength). A position counts as an entry boundary when three
 * entries chain end to end from it, or the chain runs off the slice.
 */
function owlSliceEntries(bytes, hashLength) {
  const header = (i) => {
    if (bytes[i] !== 0x12) return null;
    let len = 0, shift = 0, j = i + 1, b;
    do {
      if (j >= bytes.length || shift > 28) return null;
      b = bytes[j++];
      len += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    if (bytes[j] !== 0x0a || bytes[j + 1] !== hashLength) return null;
    return { body: j, end: j + len };
  };
  const isBoundary = (i) => {
    for (let n = 0; n < 3; n++) {
      if (i >= bytes.length) return true;
      const h = header(i);
      if (!h) return n > 0 && i > bytes.length - 16; // a header cut off by the slice
      i = h.end;
    }
    return true;
  };

  let i = 0;
  while (i < bytes.length && !isBoundary(i)) i++;
  const entries = [];
  for (let h; (h = header(i)) && h.end <= bytes.length; i = h.end) {
    entries.push({ offset: i, end: h.end, hash: bytes.subarray(h.body + 2, h.body + 2 + hashLength), entry: bytes.subarray(h.body, h.end) });
  }
  return entries;
}

async function owlLookupRanged(path, hash) {
  const share = (hash[0] * 2 ** 24 + hash[1] * 2 ** 16 + hash[2] * 2 ** 8 + hash[3]) / 2 ** 32;
  let start = Math.max(0, Math.round(share * owlSizeGuess - OWL_WINDOW / 2));
  let end = start + OWL_WINDOW - 1;

  for (let attempt = 0; attempt < 4; attempt++) {
    const slice = await owlFetchRange(path, start, end);
    if (slice.total) owlSizeGuess = Math.round((owlSizeGuess * 3 + slice.total) / 4);

    const entries = owlSliceEntries(slice.bytes, hash.length);
    if (!entries.length) break;
    const first = entries[0], last = entries[entries.length - 1];
    const atStart = slice.start === 0;
    const atEnd = slice.start + slice.bytes.length >= (slice.total ?? Infinity) || slice.bytes.length < end - start + 1;

    if (owlCompare(hash, first.hash) < 0 && !atStart) {
      end = slice.start + first.offset - 1;
      start = Math.max(0, end + 1 - OWL_WINDOW);
    } else if (owlCompare(hash, last.hash) > 0 && !atEnd) {
      start = slice.start + last.end;
      end = start + OWL_WINDOW - 1;
    } else {
      const match = entries.find((e) => owlCompare(e.hash, hash) === 0);
      return match ? owlEntryID(match.entry) : null;
    }
  }
  throw new Error('range lookup did not converge'); // owlResolve falls back to the whole file
}

/* How the last lookup went: { ranged, ms }, for the status app. */
let owlLastLookup = null;

/* Returns the Apple News article ID for a web URL, or null if News has none. */
async function owlResolve(url, { ranged = true } = {}) {
  const canonical = owlCanonicalize(url);
  if (!canonical) return null;

  const { group, bucketCount, hashLength } = await owlConfig();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
  const hash = digest.subarray(0, hashLength);

  let bucket = 0n;
  for (let i = hash.length - 1; i >= 0; i--) bucket = (bucket << 8n) | BigInt(hash[i]);
  bucket %= BigInt(bucketCount);

  const path = `${group}/index/${bucket}`;
  const started = Date.now();
  let id;
  try {
    if (!ranged) throw new Error('ranged lookups off');
    id = await owlLookupRanged(path, hash);
  } catch {
    // The CDN rejects CORS preflights, so a browser that preflights Range
    // requests can only use the whole file.
    ranged = false;
    id = await owlLookupFull(path, hash);
  }
  owlLastLookup = { ranged, ms: Date.now() - started };
  return id;
}

if (typeof module !== 'undefined') module.exports = { owlCanonicalize, owlResolve };
