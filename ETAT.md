# ÉTAT du chantier « qualité de la génération » — fork drawio (api-server)

Mis à jour le 2026-10-03 au soir. Un nouveau contexte doit pouvoir reprendre en lisant ce fichier.
Rien du corpus IEEE ici : chiffres, chemins et identifiants de code seulement.

## Contraintes fermes d'Eric (plan qualité validé)

- Réglage et mesure sur des **milliers** de circuits ; résultats **par famille**, jamais seulement une moyenne ;
  circuits **réels** et variantes **générées** toujours séparés, l'acceptation se décide sur les réels.
- **50 circuits scellés** pour la notation finale d'Eric : tirés avant tout réglage, jamais vus ni réglés
  (ni eux ni leurs variantes). Fichiers dans `/AI/datasets/netlists/sealed` (0700), seulement leurs empreintes dans
  `api-server/benchmark/sealed-50.json`. Garde-fou obligatoire : `lib/sealed.js` (`assertNotSealed`, `bankExclusions`).
- Notation d'Eric : **une seule fois**, 50 images, page mobile (une image, note 1-5, suivante), seulement quand **toutes**
  les familles passent les seuils automatiques. Cible : ≥ 80 % de circuits sans erreur, ≤ 10 % de feuilles > 3:1,
  note humaine médiane ≥ 4, aucune ≤ 2.
- **Familles jamais vues** (mesure de généralisation, ne JAMAIS régler dessus) : `regulator` (LDO), `sampler-sc`,
  `data-converter`. Un gabarit LDO réglé sur `regulator` est interdit sans qu'Eric change cette frontière.
- **Juge Ornith (lisibilité par paires) : en observation seulement**, ne sert pas à choisir ; ne pas optimiser pour lui.
- Entraînement : schémas **DVD seulement** (`figures.origine IN ('dvd-2001','dvd-2008')`), usage privé ; **Xplore exclu**.
  Corpus IEEE : rien dans Git, rien hors d'ai-station.
- Pas de D synthétique (génération jugée trop mauvaise pour servir de base).
- Main `dev` du fork protégée par Eric : PR, fusion par l'orchestrateur sur accord d'Eric. Branche de travail `motif-templates`.

## Où sont les choses

| Quoi | Où |
|---|---|
| Banque de netlists (hors Git) | `/AI/datasets/netlists/bank/` — `manifest.jsonl`, `manifest-openpdk.jsonl`, `inventory.jsonl`, `excluded.jsonl` |
| Sources clonées | `/AI/datasets/netlists/{AnalogGenie,ams.net.github.io,spice-datasets}`, `/AI/datasets/netlists/openpdk/{hits.jsonl,licences.json,raw/}` |
| Résultats des bancs | `/AI/datasets/netlists/runs/<nom>/shard-*.jsonl` |
| Lot de correction RF (DVD) | `/AI/datasets/IEEE/derived/correction/rf-1/` (100 items + img) |
| Catalogue du RAG | `/AI/datasets/IEEE/derived/figures.sqlite` (lecture seule), `FIGURES-README.md` |
| Étiquettes livrées au RAG | `/AI/datasets/IEEE/derived/etiquettes-recognize.jsonl` (version recognize-2) |
| Index motifs IEEE | `/AI/datasets/IEEE/derived/motif-index.json` |

Outils (dans `api-server/tools/`) : `import-corpora.py`, `inventory-bank.mjs`, `seal-eval.mjs`, `bench-families.mjs`
(`run` / `sum`, options `--split`, `--engine`, `--sources`, `--exclude-source`), `crawl-openpdk.py`
(`search|fetch|convert`, `--pace 1.5` : quota GitHub 5 000/h partagé entre sessions), `judge-pairs.mjs`,
`dvd-rf-batch.mjs`, `correct-session.sh`, `label-readings.mjs`, `function-eval.mjs`.
Node : `~/.local/node/bin` (hors PATH). Ne jamais tuer par motif (`pkill -f`) : tuer par PID.

## Chiffres (banc par famille, `check.py`, engine=auto, circuits à famille sûre)

| | début de journée | après PR #5 (fusionnée) |
|---|---|---|
| réglage (906) : sans erreur / feuilles > 3:1 | 43 % / 50 % | 45 % / 6 % |
| test (579) | 42 % / 50 % | 49 % / 7 % |
| familles jamais vues (937) | 12 % / 77 % | 15 % / 8 % |

Depuis : commit `0a299c8` (miroirs d'un même groupe dans un même bloc v4) — réglage 1 935 → 1 901 erreurs.
Juge `check.py` corrigé (commit `96bbc74`) : la règle 26 mêlait NMOS et PMOS d'un même nœud de grille (faux positifs).
**Nouvelle référence (juge corrigé, banque d'origine sans open PDK, run `full-3`)** :
réglage 905 : 46 % sans erreur, 5 % > 3:1, 1 837 erreurs ; test 579 : 49 %, 7 %, 1 373 ;
familles jamais vues 937 : 16 %, 3 %, 3 977. Comparer les prochains changements à CES chiffres.

Constat clé : le choix d'auto par nombre d'erreurs n'est pas aligné avec la lisibilité (juge Ornith par paires préfère
v2 79 fois contre 16 sur 144 dessins différents ; net sur une bandgap, marginal ailleurs).

## Chantier en cours

1. **Gabarits de structure** : bandgap (famille `reference`), comparateur (`comparator`). LDO seulement mesuré.
   Déjà fait : branches prolongées (`place2 opts.branchExtend`, actif dans les blocs v4), substrat des BJT, groupes de miroirs.
2. **Open PDK** : téléchargement complet (7 292 fichiers, 628 dépôts), 6 640 netlists converties, **1 707 utilisables
   et distinctes** (inventaire complet, 7 s ; le blocage venait de la détection des paires, corrigée dans `patterns.js`).
   Familles « par nom » : PLL 271, ADC 206, opamp 192, comparateur 101, DAC 97, référence 89, oscillateur 51, régulateur 42…
   Licences : Apache-2.0 688, MIT 222, sans licence déclarée 688 (usage privé d'évaluation seulement).
   ADC/DAC → famille `data-converter` = JAMAIS VUE : mesure seulement. Mesure séparée : `--sources openpdk`.
3. **Page de correction** `/correct` prête (lot rf-1). Eric doit lancer une fois
   `sudo tailscale serve --bg --https=8443 http://127.0.0.1:8770`, puis `tools/correct-session.sh` ;
   URL https://ai-station.tail10543b.ts.net:8443/correct?batch=rf-1 ; fin : `correct-session.sh --stop` puis `sudo tailscale serve --https=8443 off`.
