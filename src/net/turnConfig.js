// Optional TURN relay configuration.
//
// BudGame is serverless by default: STUN only, direct peer-to-peer. That fails
// for roughly one pairing in six (symmetric NAT on either side, or a firewall
// that blocks outbound UDP entirely). The only real cure is a TURN relay, which
// IS a third-party server — so it stays strictly opt-in and is never bundled
// with the game.
//
// Two ways to supply one, in priority order:
//   1. the "options avancées" form in the lobby (stored in localStorage,
//      per browser, never committed anywhere);
//   2. build-time env vars, for someone who wants their own deployment to have
//      a fallback: VITE_TURN_URL / VITE_TURN_USER / VITE_TURN_PASS.
//
// Only ONE of the two players needs it: the relay candidate that side gathers
// is carried inside the invite/answer token and the other end connects to it.

const STORAGE_KEY = 'budgame.turn';

function fromEnv() {
  const urls = import.meta.env.VITE_TURN_URL;
  if (!urls) return null;
  return {
    urls,
    username: import.meta.env.VITE_TURN_USER || '',
    credential: import.meta.env.VITE_TURN_PASS || '',
  };
}

export function loadTurnConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const cfg = JSON.parse(raw);
      if (cfg && cfg.urls) return cfg;
    }
  } catch {
    /* private mode / corrupted entry: fall back to the build-time default */
  }
  return fromEnv();
}

export function saveTurnConfig(cfg) {
  try {
    if (cfg && cfg.urls) localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable: the config simply won't survive a reload */
  }
}

/**
 * Turn whatever the user pasted into URLs the browser will actually accept.
 *
 * Provider dashboards (ExpressTURN in particular) hand out a bare
 * "host:port" — feeding that to RTCPeerConnection throws
 * `SyntaxError: '…' is not a valid stun or turn URL`, which would break the
 * whole connection. So: add the missing `turn:` scheme, and when no transport
 * is pinned, register both UDP and TCP variants (TCP is what gets through
 * firewalls that drop UDP).
 */
export function normalizeTurnUrls(raw) {
  const out = [];
  for (const part of String(raw || '').split(/[,\s]+/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const url = /^(turns?|stun):/i.test(trimmed) ? trimmed : 'turn:' + trimmed;
    if (/^turn:/i.test(url) && !/[?&]transport=/i.test(url)) {
      out.push(url + '?transport=udp', url + '?transport=tcp');
    } else {
      out.push(url);
    }
  }
  return [...new Set(out)];
}

/** iceServers entries for a given config (empty when not configured). */
export function buildIceServers(cfg) {
  if (!cfg || !cfg.urls) return [];
  const urls = normalizeTurnUrls(cfg.urls);
  if (!urls.length) return [];
  const entry = { urls };
  if (cfg.username) entry.username = cfg.username;
  if (cfg.credential) entry.credential = cfg.credential;
  return [entry];
}

/** iceServers entries to append to the STUN list (empty when not configured). */
export function turnIceServers() {
  return buildIceServers(loadTurnConfig());
}

function describeTurnErrors(errors) {
  const codes = new Set(errors.map(e => e.code));
  if (codes.has(401)) return 'Identifiants refusés par le relais (401). Vérifiez utilisateur / mot de passe.';
  if (codes.has(403)) return 'Relais accessible mais accès refusé (403) : quota dépassé ?';
  if (codes.has(701)) return 'Relais injoignable (DNS ou UDP/TCP sortant bloqué vers ce port).';
  if (errors.length) return `Le relais n'a pas répondu (code ${[...codes].join(', ')}).`;
  return "Aucun candidat relais obtenu : le relais n'a pas répondu.";
}

/**
 * Actually exercise a TURN config: allocate through it and report back.
 * `iceTransportPolicy: 'relay'` discards host/srflx candidates, so a candidate
 * appearing at all proves the relay accepted us.
 */
export function testTurnConfig(cfg, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const servers = buildIceServers(cfg);
    if (!servers.length) return resolve({ ok: false, message: 'Aucune URL de relais renseignée.' });

    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers: servers, iceTransportPolicy: 'relay' });
    } catch (err) {
      return resolve({ ok: false, message: 'URL de relais invalide : ' + err.message });
    }

    const protocols = new Set();
    const errors = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { pc.close(); } catch { /* already closed */ }
      resolve(protocols.size
        ? { ok: true, message: `Relais OK (${[...protocols].join(' + ')}). Il sera utilisé en dernier recours.` }
        : { ok: false, message: describeTurnErrors(errors) });
    };
    const timer = setTimeout(finish, timeoutMs);

    pc.addEventListener('icecandidate', (e) => {
      if (!e.candidate) return finish();
      if (e.candidate.type === 'relay') {
        protocols.add((e.candidate.protocol || 'udp').toUpperCase());
        finish();
      }
    });
    pc.addEventListener('icecandidateerror', (e) => errors.push({ code: e.errorCode, text: e.errorText }));

    pc.createDataChannel('probe');
    pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => finish());
  });
}

/**
 * Turn the ICE outcome into something a human can act on.
 * @param {Set<string>} types candidate types actually gathered
 * @param {boolean} hasTurn whether a relay was configured at all
 */
export function diagnoseIceFailure(types, hasTurn) {
  if (types.has('relay')) {
    return 'Échec malgré le relais TURN : vérifiez les identifiants du relais, '
      + 'ou essayez son port 443/TLS.';
  }
  if (!types.has('srflx')) {
    return "Aucune adresse publique obtenue : l'UDP sortant est bloqué "
      + '(pare-feu entreprise/école). Essayez un autre réseau, un partage de '
      + 'connexion mobile, ou configurez un relais TURN sur port 443.';
  }
  if (hasTurn) {
    return 'Adresse publique obtenue mais le relais TURN n\'a pas répondu : '
      + 'identifiants ou URL probablement incorrects.';
  }
  return 'Connexion directe impossible : NAT symétrique (réseau d\'entreprise '
    + 'ou 4G/5G) d\'au moins un côté. Essayez un autre réseau, ou configurez un '
    + 'relais TURN dans les options avancées.';
}
