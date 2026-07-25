# BudGame2026

3D parody fighting game built with [BabylonJS](https://www.babylonjs.com/) and Vite.

**▶️ Play it now: https://sailro.github.io/BudGame2026/**

Four fighters with caricatured special moves:

| Fighter | Special |
|---------|---------|
| **Pat**  | Coup de Bide (belly bash) |
| **Bud**  | Coup de Pied Sauté (jump-kick) |
| **Seb**  | Coup de Pif (giant nose) |
| **Nico** | Lancer de Caillou (rock throw) |

## Controls

| | Move | Jump | Block | Punch | Kick | Special |
|---|---|---|---|---|---|---|
| **J1** | A / D | W | S | F | G | H |
| **J2** | ← / → | ↑ | ↓ | J | K | L |

F1 toggles hurtbox/hitbox debug.

Online, you drive a single fighter and **both** key maps work, so you can use
whichever half of the keyboard you like.

## Play online (serverless peer-to-peer)

Click **JOUER EN LIGNE** in the menu. There is no game server, no matchmaking
service and no signalling broker: the two browsers talk to each other directly
over a WebRTC data channel, and the connection handshake is done by
copy-pasting a code through whatever chat you already use.

1. **Player 1** clicks *CRÉER UNE PARTIE* and sends the generated link (or code)
   over Discord / SMS / mail.
2. **Player 2** opens the link — the code is filled in automatically — clicks
   *GÉNÉRER MA RÉPONSE*, and sends the reply code back.
3. **Player 1** pastes the reply and clicks *CONNECTER*. Fight!

Player 1 hosts: they own the simulation, pick their own fighter and start the
round; player 2 streams their input and receives 60 Hz state snapshots. About
5 kB/s each way.

> The invite code embeds your SDP, which contains your local and public IP
> addresses. Share it only with the person you want to play against.

### If the connection fails

Only public STUN servers are contacted (to discover your own public address),
so a direct UDP path between the two machines is required. That works on the
large majority of home connections, but not always:

| Situation | Result |
|---|---|
| Same LAN / Wi-Fi, or working IPv6 on both ends | ✅ |
| Home router ↔ home router | ✅ most of the time |
| Symmetric NAT (corporate networks, some 4G/5G and CGNAT) | ❌ |
| Firewall blocking outbound UDP (company, school) | ❌ |

The lobby tells you which of the two you hit. Easiest fixes: play from home
rather than a corporate/mobile network, or put both players on the same
LAN/VPN.

The only real cure is a **TURN relay**, which is by definition a third-party
server — so it is strictly opt-in and never bundled. Under
*Options avancées* you can paste credentials for a free relay (ExpressTURN,
Metered Open Relay…); they are stored in your browser's `localStorage` only,
and **only one of the two players needs to configure one**. Note that a relay
reached over TCP/TLS will add noticeable input lag compared to UDP.

For a self-hosted build you may instead bake in a default relay at build time:

```bash
VITE_TURN_URL="turn:relay.example.com:443?transport=tcp" \
VITE_TURN_USER=user VITE_TURN_PASS=secret npm run build
```

Never commit those values — pass them as CI secrets. Anything shipped in a
static site is readable by anyone who opens the bundle.

## Local dev

```bash
npm install
npm run dev          # http://localhost:5173
```

To rebuild the face / head textures from the source photos:

```bash
pip install opencv-python Pillow
python scripts/extract_faces.py
```

If you want to override a character's photo, drop your own PNG at
`photos/{pat,bud,seb,nico}.png` and re-run the script.

## Production build

```bash
npm run build        # outputs dist/
npm run preview      # serve dist/ locally
```

## Deployment (GitHub Pages)

This repo ships with `.github/workflows/deploy.yml` which builds the site and
publishes it to GitHub Pages on every push to `main`. The Vite `base` in
`vite.config.js` is set to `/BudGame2026/`, matching the repo name. If you
fork under a different name, update that value (or override at build time
with `VITE_BASE=/your-repo/ npm run build`).

In your GitHub repo settings → **Pages**, set the source to **GitHub Actions**.
The first successful workflow run publishes the site at
`https://<your-user>.github.io/BudGame2026/`.
