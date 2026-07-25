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

/** iceServers entries to append to the STUN list (empty when not configured). */
export function turnIceServers() {
  const cfg = loadTurnConfig();
  if (!cfg) return [];
  const entry = { urls: cfg.urls.split(',').map(s => s.trim()).filter(Boolean) };
  if (cfg.username) entry.username = cfg.username;
  if (cfg.credential) entry.credential = cfg.credential;
  return entry.urls.length ? [entry] : [];
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
