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

/* Returns the Apple News article ID for a web URL, or null if News has none. */
async function owlResolve(url) {
  const canonical = owlCanonicalize(url);
  if (!canonical) return null;

  const { group, bucketCount, hashLength } = await owlConfig();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
  const hash = digest.subarray(0, hashLength);

  let bucket = 0n;
  for (let i = hash.length - 1; i >= 0; i--) bucket = (bucket << 8n) | BigInt(hash[i]);
  bucket %= BigInt(bucketCount);

  const index = await owlFetch(`${group}/index/${bucket}`);
  for (const [field, entry] of protoFields(index)) {
    if (field !== 2) continue;
    const e = Object.fromEntries(protoFields(entry));
    if (e[1].length === hash.length && e[1].every((b, i) => b === hash[i])) {
      return new TextDecoder().decode(Object.fromEntries(protoFields(e[2]))[1]);
    }
  }
  return null;
}

if (typeof module !== 'undefined') module.exports = { owlCanonicalize, owlResolve };
