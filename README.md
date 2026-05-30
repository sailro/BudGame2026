# BudGame2026

3D parody fighting game built with [BabylonJS](https://www.babylonjs.com/) and Vite.

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
