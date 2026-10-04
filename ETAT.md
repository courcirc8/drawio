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
- Main `dev` du fork protégée par Eric : PR, fusion par l'orchestrateur sur accord d'Eric. Branche de travail `motif-templates` (PR #2 à #6 fusionnées ; #6 = commit 4b09a8f).

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

## Correctifs de justesse (soir du 2026-10-03)

- `check.py` règle 26/28 : groupes de miroir par polarité ET par nœud de source (faux positifs : NMOS sous un miroir
  PMOS, miroir cascode 2×2). Les chiffres « run full-3 » ci-dessus précèdent la seconde correction : remesurer.
- Analyseur : noms de nœuds insensibles à la casse (`Vin` = `vin`) ; substrat des BJT ; `patterns.js` borné
  (tableaux de cellules) et rails des PDK ouverts reconnus.
- `auto` n'élit jamais un dessin qui échoue au LVS ; `place2` ne perd plus les dérivations d'un élément de chaîne partagé.
  Résultat : les 80 netlists open PDK qui échouaient au LVS passent toutes.

## RÉFÉRENCE ACTUELLE (run `full-4` / `openpdk-2`, juge corrigé, correctifs LVS) — comparer à ceci

| | réglage | test | familles jamais vues |
|---|---|---|---|
| banque d'origine : sans erreur / > 3:1 | 51 % / 5 % (905) | 55 % / 7 % (579) | 25 % / 3 % (937) |
| open PDK : sans erreur / > 3:1 | 34 % / 13 % (459) | 33 % / 15 % (297) | 34 % / 11 % (345) |
0 échec LVS. Références (réglage) : 40 % sans erreur, erreurs surtout de routage (pin-clearance, 22-contact, through).

## DÉCISION D'ERIC (2026-10-03 soir) : GO juge appris sur les DVD — premier jalon 2-3 jours

Pourquoi : le juge à règles (check.py) et l'œil se contredisent (bandgap 1645 : auto choisit un éparpillement à 1 erreur
contre le dessin de manuel « v2+branches » à 2 erreurs ; règle AUTO_BAND=1 : 50,8 % → 38,8 % sans erreur). Images :
`~/ClaudeCode/schematic/qualite-exemples/bandgap-1645-*.png`. Il faut un arbitre indépendant.

Contraintes : (a) il doit juger la DISPOSITION, pas le style : normaliser les deux côtés au même rendu, et tester sur des
paires « même dessin, styles différents » qui doivent donner égalité ; (b) NE PAS l'utiliser pour choisir dans auto avant
validation ; (c) jamais les 50 scellés ni leurs variantes (lib/sealed.js) ; (d) modèle privé sur ai-station ;
données DVD seulement (`figures.origine IN ('dvd-2001','dvd-2008')`, `lectures.readable`).

Plan (à exécuter) :
1. Jeu de données : recadrages des schémas DVD lisibles (outil de recadrage du RAG, un rendu à la fois ; code dans le
   worktree `/tmp/claude-1000/local_AI-main/rag` ou le clone local_AI à jour), normalisés (niveaux de gris, binarisation,
   squelettisation/épaisseur de trait fixe, même résolution) ; nos rendus des circuits de la banque (hors scellés)
   passés par la MÊME normalisation. Tout sous `/AI/datasets/judge/` (hors Git).
2. Tâche : classifieur « publié / généré » sur images normalisées, ou mieux un score de paire. LoRA d'un VLM local
   (ou petit CNN/ViT si plus simple) sur un GPU d'ai-station (vérifier la carte libre : sgl-ornith occupe une carte).
3. Validation : constance entre les deux ordres, cas témoins (bandgap 1645 : v2+branches > éparpillement),
   paires « même dessin, styles différents » → égalité, précision sur un jeu publié/généré mis de côté.
4. Rapporter à l'orchestrateur ; ne rien brancher dans auto sans accord.

Avancement (soir du 2026-10-03) : outils dans `api-server/tools/judge/` (normalize.py — réduction BOX + seuil 245 pour
garder les fils fins ; build-pub.py ; render-gen.mjs ; normalize-dir.py ; train.py = ResNet18 1 canal, de zéro,
dégradations identiques des deux côtés, découpage par article / par circuit). Constructions lancées
(`/AI/datasets/judge/pub`, `gen-raw` → `gen`), puis entraînement chaîné (`/AI/datasets/judge/pipeline.log`,
modèle `models/judge-v1.pt`). À faire ensuite : eval.py — invariance au style (même dessin, styles différents → égalité),
cas témoin bandgap 1645 (v2+branches > éparpillement), score sur le jeu de test.

## Juge DVD v1 : ÉCHEC DE VALIDATION (2026-10-04) — ne pas utiliser

Entraîné : 13 562 schémas DVD lisibles contre 9 210 de nos rendus, texte retiré des deux côtés, familles équilibrées ;
test acc 98,7 %, AUC 0,999 (trop facile). Tests `tools/judge/eval.py` :
- style : échelle 0,6 / 1,6 → |Δ| 0,09 / 0,08 (correct) ; traits épaissis → **0,31** ; bruit de scan → **0,20** (échec) ;
- texte gardé ou retiré → 0,07 ;
- témoin bandgap : 0,001 contre 0,000 → sans valeur (tous nos dessins ~0) ;
- jeu de test : publiés 0,97, nôtres 0,01 → sépare scan/rendu propre, pas disposition bonne/mauvaise.
Modèle `/AI/datasets/judge/models/judge-v1.pt` gardé pour mémoire seulement.
Pistes v2 : ramener les deux côtés à une même abstraction (squelette des traits → épaisseur fixe, symboles
réduits à des boîtes ou retirés, seuls fils et positions), entraîner sur des PAIRES de nos propres dessins
en n'utilisant les DVD que comme distribution de référence, ou détecter les composants dans les figures DVD
(boîtes) pour comparer des positions relatives plutôt que des pixels.

## DÉCISION D'ERIC (2026-10-04) : juge v2 = piste (2) puis (3) — détecteur de composants, puis positions relatives

Plan (étape 1 en cours : AMSNet extrait dans `/AI/datasets/judge/amsnet/amsnet_1.0/`, format des boîtes établi ; détecteur `tools/judge/train-detector.py` en entraînement → `/AI/datasets/judge/models/detector-v1.pt`, journal `/AI/datasets/judge/detector-train.log`, précision/rappel par classe dans `detector-v1.metrics.json`) :
1. Détecteur de composants entraîné sur **AMSNet** (734 circuits : image d'origine + boîtes dessinées à la main + netlist ;
   GPL, usage privé OK). Archive : `/AI/datasets/netlists/ams.net.github.io/amsnet_1.0-*.zip`, par circuit
   `<id>.jpg`, `<id>_bbox.json` (clés `<classe>_<rotation>` → listes **`[y0,x0,y1,x1]` (ligne, colonne ; vérifié à l'œil, l'ordre x,y ne tient pas pour 480 circuits)** ; classes : nmos, pmos,
   nmos-mirror, pmos-mirror, nmos-cross, pmos-cross, resistor, capacitor, inductor, current, voltage, vdd, gnd,
   net-black, net-white, current-arrow…), `<id>.cir`. Détecteur conseillé : torchvision Faster R-CNN (déjà installé,
   système python, carte GPU 1) ; classes regroupées (transistor N/P avec orientation, R, C, L, sources, vdd, gnd).
   Vérifier qu'aucun circuit AMSNet n'est scellé ou variante (lib/sealed.js) avant entraînement.
2. Valider sur un échantillon de figures DVD (précision visuelle à contrôler SANS sortir d'image du corpus : comptes,
   cohérence avec `lectures.components` du RAG — nombre de transistors/R/C détectés vs lus).
3. Appliquer aux 13 562 schémas DVD (`/AI/datasets/judge/pub-raw/`, origine dvd-* seulement) → positions et classes
   des composants → statistiques de disposition (positions relatives par motif : charge au-dessus, miroir sur une
   rangée, PMOS au-dessus des NMOS, symétrie, signal à gauche…).
4. Juge v2 : comparer les positions relatives de NOS dessins (connues exactement depuis le .drawio) à ces
   statistiques → score indépendant du style. Tests obligatoires : « même disposition, styles différents » → même
   score (trivial ici : on part des positions, pas des pixels), témoin bandgap 1645 (v2+branches > éparpillement),
   séparation publiés/générés sur des positions. Rien dans auto avant validation et accord d'Eric. Modèle privé.

## Détecteur v1 (2026-10-04) : excellent sur AMSNet, NE TRANSFÈRE PAS aux scans DVD

- Validation AMSNet (73 circuits) : précision/rappel NMOS 0,98/0,99, PMOS 0,91/0,97, R 0,99/1,00, C 0,96/1,00, VDD 0,86/0,90.
- Sur 300 figures DVD, comparé aux composants lus par Ornith (RAG) : transistors détectés 0,34 NMOS + 0,14 PMOS par figure
  contre 3,3 + 1,7 lus ; R 0,98 contre 1,36 ; C 0,26 contre 1,37. Agrandir l'image ×2/×3 ne change rien
  (0,4 transistor contre 4,5 lus) : c'est le STYLE des symboles (manuels contre articles scannés), pas l'échelle.
- Outils : `tools/judge/train-detector.py`, `tools/judge/detect-dvd.py --check N` (comptes seulement, aucune image ne sort).
- Pistes : (a) réentraîner avec des dégradations « scan » d'AMSNet (sous-résolution 150 ppp, bruit, flou, JPEG,
  épaisseur) ; (b) ajouter nos propres dessins rendus (boîtes exactes connues) avec styles aléatoires ;
  (c) annotation de quelques centaines de figures DVD par Eric (coûteux pour lui, seulement si (a)+(b) échouent).
- En cours : (a) `train-detector.py --scan-aug` → `detector-v2.pt`, vérifié par `detect-dvd.py --check 300 --model …v2.pt`.
- Étape intermédiaire AVANT (c) (orchestrateur, Eric ne veut pas de longues annotations) : PSEUDO-ÉTIQUETTES —
  (1) demander à Ornith des boîtes approximatives en plus des composants, ou utiliser ses décomptes par type comme
  contrainte faible ; (2) auto-apprentissage : garder les détections confiantes ET cohérentes avec les décomptes
  d'Ornith, réentraîner, itérer ; mesurer sur un petit jeu DVD vérifié à part. Eric seulement en dernier recours,
  lot court, interface simple.

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
