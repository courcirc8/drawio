# holdout-ltspice — corpus de validation HORS entraînement

131 circuits publics LTspice (mick001/Circuits-LTSpice, le banc de Schemato et
de Weave) convertis en SPICE plat par `tools/asc2spice.mjs`. **Aucun de ces
circuits n'a servi à dériver les règles de `training/RULES.md`** : c'est la
première mesure honnête de généralisation du générateur au-delà des 43
topologies de `benchmark/netlists30`.

Règle d'or (contrat routing-v2) : on mesure ici, on ne règle jamais ici. Une
règle découverte sur ce corpus se code, puis se re-mesure sur les DEUX bancs.

## Contenu

- `*.cir` : 131 netlists (une par `.asc`), `manifest.json` : par circuit,
  symboles LTspice utilisés, éléments non dessinables, `supported`.
- 65 circuits sont **entièrement dessinables** (R C L D V I Q M seulement) ;
  66 sont partiels (interrupteurs `sw`, sources comportementales `bv`,
  ampli-op `Opamps\…`, comparateurs, NE555, portes `Digital\…`). Les lignes
  non supportées sont écrites mais ignorées à l'import (avertissement) :
  ces circuits ne testent le placeur que partiellement.

Régénérer :

```sh
node tools/asc2spice.mjs --corpus <clone de Circuits-LTSpice> benchmark/holdout-ltspice
```

Mesurer (même juge `tools/check.py`, même serveur, même format que le banc
d'entraînement) :

```sh
DRAWIO_BASE=http://127.0.0.1:8775 python3 benchmark/run30.py /tmp/holdout --optimize 2 \
  --nets benchmark/holdout-ltspice --only $(node -e "console.log(require('./benchmark/holdout-ltspice/manifest.json').filter(m=>m.supported).map(m=>m.name).join(','))")
```

## Baseline mesurée — 2026-09-18 (dev + correctif du nom de rail, optimize 2)

| | banc d'entraînement (43) | holdout dessinable (65, avant extension SPICE) | holdout dessinable (111, code final) |
|---|---|---|---|
| générés | 43/43 | 64/65 (1 rejet LVS : passifs sans valeur, corrigé côté convertisseur) | 111/111 |
| LVS | 43/43 | 64/64 | 111/111 |
| circuits à 0 erreur | 40/43 | 39/65 | 56/111 |
| erreurs checker totales | 3 | 219 | 545 |
| beauty moyen | 74,2 | 60,7 | 49,4 |
| durée (optimize 2, 43 : optimize 8) | 78 s | — | 248 s |

Règles en erreur (111) : through 183, 22 105, 22-contact 82, pin-clearance 63,
wrap-around 60, comp-overlap 33, 30 9, 29 6, dot-foreign 4. Les 46 circuits
ajoutés par l'extension SPICE (ampli-op, interrupteurs, sources contrôlées)
sont les plus durs : 16/46 à zéro, beauty 33,7.

Pires circuits : Differential-pair (46 err, beauty 0), Push-pull-amplifier-AB-BJT
(39), Common-emitter-BJT (13), Three-phase-rectifier (13), zero-crossing-detector-2
(10), diode-ring-mixer (9), Logic-gates-transistors-BJTs (7).

Lecture : le générateur est solide sur les topologies qui ressemblent au banc
(miroirs, suiveurs, filtres RC, redresseurs simples : 39 circuits parfaits) et
s'effondre sur les **étages BJT discrets à polarisation résistive** (paires
différentielles à diviseurs, push-pull classe AB, émetteur commun multi-étages),
absents des 43 topologies MOS/RF d'entraînement. Le premier défaut trouvé était
même un plantage : le tap d'alimentation portait le libellé `VDD` en dur, donc
un net `Vcc` échouait au LVS strict (corrigé dans `lib/place2.js`).
