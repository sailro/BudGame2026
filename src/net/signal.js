// Serverless WebRTC signalling helpers.
//
// There is NO signalling server: the two browsers exchange their SDP session
// descriptions out-of-band (Discord, SMS, e-mail...). To keep those blobs
// copy-pasteable we deflate them and encode the result as base64url.
//
//   "B1<base64url>"  deflate-raw compressed JSON  (~700 chars)
//   "B0<base64url>"  plain JSON, fallback when CompressionStream is missing
//
// A raw SDP offer is ~2.5 kB of text; compressed it comfortably fits in a chat
// message or an URL fragment.

const PREFIX_DEFLATE = 'B1';
const PREFIX_RAW = 'B0';

function bytesToBase64Url(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipeThrough(bytes, stream) {
  const blobStream = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(blobStream).arrayBuffer());
}

/** Serialize an RTCSessionDescription into a short shareable token. */
export async function encodeSignal(desc) {
  const bytes = new TextEncoder().encode(JSON.stringify({ t: desc.type, s: desc.sdp }));
  if (typeof CompressionStream === 'function') {
    try {
      const packed = await pipeThrough(bytes, new CompressionStream('deflate-raw'));
      return PREFIX_DEFLATE + bytesToBase64Url(packed);
    } catch {
      /* fall through to the uncompressed encoding */
    }
  }
  return PREFIX_RAW + bytesToBase64Url(bytes);
}

/**
 * Parse a token produced by encodeSignal. Tolerates surrounding whitespace and
 * accepts a full share URL (we only keep what follows `#join=`).
 */
export async function decodeSignal(token) {
  let raw = String(token || '').trim();
  const hashIdx = raw.indexOf('#join=');
  if (hashIdx >= 0) raw = raw.slice(hashIdx + 6);
  raw = raw.replace(/\s+/g, '');
  if (!raw) throw new Error('Code vide');

  const prefix = raw.slice(0, 2);
  const body = raw.slice(2);
  let bytes;
  if (prefix === PREFIX_DEFLATE) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('Ce navigateur ne sait pas décompresser le code');
    }
    bytes = await pipeThrough(base64UrlToBytes(body), new DecompressionStream('deflate-raw'));
  } else if (prefix === PREFIX_RAW) {
    bytes = base64UrlToBytes(body);
  } else {
    throw new Error('Code invalide');
  }

  const parsed = JSON.parse(new TextDecoder().decode(bytes));
  if (!parsed || !parsed.t || !parsed.s) throw new Error('Code invalide');
  return { type: parsed.t, sdp: parsed.s };
}

/**
 * Wait until the peer connection has gathered enough ICE candidates to produce
 * a self-contained (non-trickle) description, and report which candidate types
 * were found so the caller can diagnose failures.
 *
 * Resolves with a Set containing any of 'host' | 'srflx' | 'prflx' | 'relay'.
 *
 * Some platforms never report `complete`, so we also stop once gathering has
 * been quiet for a while — but that quiet timer is only armed AFTER the first
 * candidate arrives, otherwise a slow interface (or a TURN allocation, which
 * needs a DNS lookup plus a round trip) would be cut out of the offer.
 */
export function waitForIceGathering(pc, { quietMs = 1500, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const types = new Set();
    if (pc.iceGatheringState === 'complete') return resolve(types);

    let quietTimer = null;
    const done = () => {
      clearTimeout(quietTimer);
      clearTimeout(hardTimer);
      pc.removeEventListener('icecandidate', onCandidate);
      pc.removeEventListener('icegatheringstatechange', onState);
      resolve(types);
    };
    const hardTimer = setTimeout(done, timeoutMs);

    const onCandidate = (e) => {
      if (!e.candidate) { done(); return; }   // null candidate = end of gathering
      const c = e.candidate;
      const type = c.type || (c.candidate.match(/ typ (\w+)/) || [])[1];
      if (type) types.add(type);
      clearTimeout(quietTimer);
      quietTimer = setTimeout(done, quietMs);
    };
    const onState = () => {
      if (pc.iceGatheringState === 'complete') done();
    };

    pc.addEventListener('icecandidate', onCandidate);
    pc.addEventListener('icegatheringstatechange', onState);
  });
}

/** Build the "#join=" share URL for an invite token. */
export function buildJoinUrl(token) {
  const url = new URL(window.location.href);
  url.hash = 'join=' + token;
  return url.toString();
}

/** Read an invite token out of the current URL fragment, if any. */
export function readJoinTokenFromUrl() {
  const hash = window.location.hash || '';
  const m = hash.match(/^#join=(.+)$/);
  return m ? m[1] : null;
}
