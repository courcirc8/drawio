# ETAT — cible Cadence Virtuoso (session « Cadence »)

Branche `skill-export-cadence` (worktree `~/ClaudeCode/schematic/drawio-cadence`), base `skill-export`.
Code : `api-server/exporters/cadence/`. Doc utilisateur : `docs/cadence.md`.

## Fait (11.10)
- `index.js` : netlist → placement draw.io → neutre (LVS) → grille (10, sinon 5 à échelle ×2) → **plan Virtuoso**
  (`cadence-plan/1` : unités utilisateur, y vers le haut, fils coupés à chaque point de connexion, labels pour
  rails et bulks, connectivité attendue du DECK) → `checkPlan` (règles Virtuoso) → script Python + `.il`.
- `runtime/cadence_runtime.py` / `.il` : lit les vraies broches des masters, 8 orientations, stubs en L,
  fils, labels, gnd, pins, `schCheck`, comparaison au deck par partition, rapport en comptes seulement.
- `runtime/cadence-pdk.map` : table analogLib/basic, surchargée par un fichier local (`model.<modèle> = clé`).
- Tests : `node --test exporters/cadence/test/` (faux Virtuoso + interpréteur SKILL dans `test/fake/`).

## Décisions
- Aucune coordonnée de broche Cadence dans le dépôt (analogLib et PDK propriétaires) : tout est lu à l'exécution.
- La vérification est faite contre le deck source, pas contre le neutre.

## À faire
- Premier rapport réel d'Eric → calibrer l'échelle (`scale`, défaut 0,00625 uu par px).
- Option : profil local des broches pour un second passage exact.
- Skill « schema-depuis-netlist » + PROMOTION.md (plus tard, via l'orchestrateur).
