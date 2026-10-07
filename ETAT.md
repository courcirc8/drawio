# ÉTAT du chantier « qualité de la génération » — fork drawio (api-server)

Mis à jour le 2026-10-07 (reprise après le redémarrage d'ai-station ; branche et données vérifiées intactes). Un nouveau contexte doit pouvoir reprendre en lisant ce fichier.
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
| Service web | `drawio-api.service` (systemd utilisateur, activé, survit au redémarrage) : `node server.js --port 8770` depuis CE clone (`api-server/`), 127.0.0.1 seulement ; portail https://ai-station.tail10543b.ts.net/drawio/ (accueil, /correct, /compare, /editor/). Changer de branche dans ce clone change le service : `systemctl --user restart drawio-api` après une mise à jour. Unité : `~/.config/systemd/user/drawio-api.service` |
| Sauvegarde | `/AI/datasets/{judge,evals,netlists,training}` sauvegardés chaque jour à 6 h vers `/AI/models/backup-rag` (ai-station seulement ; mis en place par la session RAG, 7 oct.) |

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
- (a) FAIT : `detector-v2.pt` (dégradations scan) — AMSNet intact (NMOS 0,98/0,99) ; sur 300 figures DVD, comptes exacts
  vs Ornith : NMOS 2 % → 9 % (écart moyen 4,7), PMOS 3 % → 9 %, R 14 % → 17 %, C 13 % → 30 %. Mieux, insuffisant.
- (b) FAIT, 1re passe : `tools/judge/self-train.py` (3 tours, filtre = top-n confiants = décomptes Ornith nmos/pmos/R/C,
  pas de boîtes croisées ; 600 → 1 148 → 1 565 figures gardées sur 10 324 du pool) → `detector-st3.pt`.
  Mesure sur 1 137 figures de papiers mis de côté (10 %, hachage `st:`+paper_id), compte exact vs lecture Ornith :
  NMOS 12 → 17,5 %, PMOS 8 → 9 %, R 15 → 35 %, C 26 → 40 % ; AMSNet val intact (NMOS 0,99/0,99).
  Inférence à min_size 1200 / max 2000 : R 40 %, C 43 %. Rendu à 300 dpi au lieu de 150 : aucun gain.
- CONSTAT : la référence Ornith est bruitée. Deux lectures Ornith indépendantes (lectures + boites-ornith.jsonl, 3 000
  figures) ne s'accordent en compte exact que NMOS 14 %, PMOS 17 %, R 37 %, C 34 %. Sur les figures où les deux
  lectures s'accordent (mes papiers de mesure, 12 à 23 par type), st3 donne le compte exact NMOS 46 %, PMOS 42 %,
  R 26 %, C 70 % (v2 : 31/17/26/43 %) ; à un près : 77/67/63/83 %. Progrès réel, échantillon trop petit.
- PROCHAINE ÉTAPE : session RAG sollicitée pour `boites` sur les 13 562 figures DVD de pub-raw (de nuit). Ensuite :
  (1) jeu de mesure = figures des papiers mis de côté où les deux lectures s'accordent ; (2) filtre pseudo-étiquettes
  = accord des deux lectures + appariement un à un des centres Ornith (tolérance 10 % de la largeur) ; relancer
  self-train depuis st3. PRÊT : `python3 tools/judge/self-train.py --boxes --start detector-st3 --tag sb --size 1200`
  (testé à vide sur les 3 000 premières boîtes : 134 figures de mesure, 1 229 du pool). Passe RAG `rag-boites-liste`
  programmée à 22 h le 4 oct. ; filtrer sur les clés de pub-raw (le fichier contient aussi d'autres figures).
- Orchestrateur (audit RAG : Ornith optimiste en absolu, fiable en relatif) : le jeu DVD de contrôle doit être vérifié par
  un autre juge qu'Ornith avant de conclure. EN ATTENTE d'Eric : (a) auditeurs Opus sur ~40 figures DVD — images hors
  station, contraire à la règle, donc seulement sur accord explicite ; (b) Eric compte 30 figures sur page mobile ;
  (c) à défaut, concordance de 3 signaux et comparaisons relatives entre versions seulement.
- DÉCISION ERIC (5 oct., relayée par l'orchestrateur puis confirmée directement à cette session) : option (a).
  RÈGLE GÉNÉRALE : les audits par Claude sont autorisés sur des ÉCHANTILLONS (quelques centaines de figures au plus),
  jamais sur le corpus entier, sans aucune copie conservée hors d'ai-station ; l'usage courant reste local (Ornith).
  Exclure les 50 scellés et leurs variantes (ils viennent de la banque de netlists, pas des figures DVD).
  Proposition pour le CLAUDE.md du projet (à valider par Eric, non appliquée) : « Corpus IEEE : rien ne sort
  d'ai-station, sauf audits par Claude sur échantillon (≤ quelques centaines), sans copie conservée ailleurs. »
- Jeu de contrôle : `/AI/datasets/judge/audit/control-40.json` (40 figures des papiers de mesure, 15 petites, 15 moyennes,
  10 grandes). Le classifieur de permissions a bloqué 2 des 4 auditeurs : seules 20 figures (1-10, 21-30) sont auditées ;
  les 20 autres restent à la main d'Eric (règle de permission à ajouter s'il veut les faire auditer).
- self-train --boxes (filtre strict, 70 → 86 figures gardées) → `detector-sb3.pt`. Mesure sur les figures où les deux
  lectures s'accordent : NMOS 26 → 31 %, PMOS 12 → 14 %, R 54 → 58 %, C 49 → 55 % ; plafond dès le tour 2.
- AUDIT OPUS (20 figures, chiffres seuls dans /AI/datasets/judge/audit/opus-*.json ; `tools/judge/audit-compare.py`),
  compte exact / écart moyen :
    ornith-1  nmos .65/.7  pmos .80/.3  R .80/2.6  C .85/.3  mos .60/1.0
    ornith-2  nmos .60/.9  pmos .60/1.4 R .55/2.4  C .65/.6  mos .55/1.7
    det-v2    nmos .60/1.1 pmos .55/1.2 R .75/2.8  C .70/1.1 mos .40/2.0
    det-st3   nmos .60/1.5 pmos .70/1.0 R .90/2.1  C .80/.5  mos .75/1.0
    det-sb3   nmos .65/1.4 pmos .75/1.3 R .90/2.1  C .85/.5  mos .65/1.5
  (mos = nmos+pmos, vérité incluant les MOS de polarité indécidable : 26 des 98 MOS comptés par Opus.)
  Lecture : l'auto-apprentissage a amené le détecteur au niveau de la 1re lecture Ornith (mieux en R et en total MOS),
  nettement au-dessus de v2. Échantillon minuscule : ordre de grandeur, pas chiffre. La polarité MOS sur scan est
  souvent indécidable même pour Opus → pour le juge de disposition, raisonner en « MOS » plutôt qu'en nmos/pmos.
- AUDIT COMPLET 40 figures (Eric a ajouté la règle Read pour pub-raw) :
    ornith-1  nmos .57/1.8 pmos .70/.8  R .75/1.9 C .78/.5  mos .60/1.2
    ornith-2  nmos .50/2.1 pmos .57/1.2 R .53/1.9 C .62/1.2 mos .45/2.2
    det-v2    nmos .50/1.4 pmos .53/1.4 R .53/3.3 C .68/1.6 mos .35/2.7
    det-st3   nmos .60/1.2 pmos .65/.9  R .70/2.5 C .72/.8  mos .68/1.1
    det-sb3   nmos .65/1.1 pmos .72/1.0 R .72/2.5 C .78/1.1 mos .65/1.3
  Conclusion confirmée : détecteur auto-entraîné ≈ meilleure lecture Ornith (mieux en MOS), ≫ v2. Retenir sb3 (ou st3).
- Eric (5 oct.) : forfait Claude serré → plus de sous-agents Claude sans demander ; déléguer à Ornith (lai-delegate).
- JUGE v2, 1er essai (`detect-all.py` sb3 sur 13 562 DVD + 9 210 rendus à nous ; `layout-stats.py` : traits de disposition
  tirés des seules boîtes ; `layout-judge.py` : régression logistique). Invariance au style bien meilleure que v1
  (épais Δ 0,08 contre 0,31 ; scan 0,06 contre 0,20), MAIS invalide : le détecteur ne trouve qu'une médiane de 14 % des
  composants de NOS dessins (masse : 1 détection en tout), seuls 4 620 sur 9 210 ont ≥ 3 pièces, le témoin 1645 « auto »
  n'a rien de détecté ; l'AUC 0,82 mesure surtout « détecteur aveugle à notre style » (fuite de style par le détecteur).
- CORRECTIF en cours : `render-gen-boxes.mjs` rend nos circuits (split train seulement) avec les boîtes exactes
  (géométrie des cellules × mapping d'export ; points de jonction cachés exclus ; vérifié à l'œil sur un rendu à nous),
  puis `self-train.py --boxes --gen-box` (fenêtres 1 600 px, moitié dégradées scan) ; mesure du rappel sur 10 % de nos
  rendus mis de côté. Ensuite : refaire detect-all (DVD + nos rendus) et layout-judge ; exiger rappel comparable des
  deux côtés AVANT de lire l'AUC.
- Détecteur sur nos rendus : gb (2 634 rendus, 88 DVD) → rappel chez nous 0,93-1,0 mais DVD en recul (nmos 31 → 18 %) ;
  gc (660 rendus/tour, DVD ×4) → DVD encore en recul (nmos 23 %, C 38 %) ; boîtes resserrées à l'encre : sans effet
  (nos MOS incluent leurs pattes jusqu'au bord de cellule), abandonné. RETENU : gd1 = `--boxes --loose-pseudo --gen-box
  --gen-n 400 --pseudo-rep 1` depuis sb3 (1 976 figures DVD pseudo-étiquetées) : DVD propre nmos 30 %, pmos 10 %,
  R 61 %, C 56 % (≈ sb3), rappel chez nous 0,87-1,0. detect-all + layout-judge relancés avec gd1.
  Repli si le juge reste biaisé : dégrader nos rendus en « scan » avant détection (mêmes erreurs des deux côtés).
- JUGE v2 avec gd1 : ÉCHEC DE VALIDATION. Traits présents des deux côtés (DVD 9 871, nous 8 956), AUC 0,865, invariance
  au style bonne (épais Δ 0,08, scan 0,03, échelle 0,02-0,03) ; MAIS témoin 1645 : v2+branches 0,08 < dispersion auto
  0,30 → FAIL ; préfère auto dans 3 142 circuits contre 1 311. Il pénalise la régularité (nos rangées 0,85 contre 0,68,
  paires MOS côte à côte 0,62 contre 0,24) : le bruit de détection sur scan rend les DVD « désordonnées ».
  Variante `--reliable` (719 figures DVD où détecteur = les deux lectures Ornith) : AUC 0,907, témoin encore FAIL
  (0,005 contre 0,10), auto préféré 2 899 contre 1 554 ; ce sous-ensemble est biaisé vers les petits circuits (peu de MOS).
  DIAGNOSTIC : le cadrage « publié contre nous » apprend les différences de contenu des circuits et de bruit de détection,
  pas la disposition. Le juge v2 n'est PAS utilisable. Pistes (décision Eric) : (1) comparaison à contenu égal
  (statistiques DVD conditionnées par le type de circuit et la taille) ; (2) se reposer sur le jugement Ornith par paires
  (fiable en relatif selon l'audit RAG) + la page de correction d'Eric ; (3) arrêter le juge appris.
- ERIC : option (1). JUGE v2b = `tools/judge/layout-rules.py` : règles lisibles à contenu égal (type de légende ×
  taille 3-6/7-12/13-25/26+, repli sur la taille si < 30 figures), mesurées sur 8 878 figures DVD (papiers train+val,
  boîtes gd1). Pour chaque trait (colonnes, rangées, paires MOS côte à côte, symétrie, empilement, vdd au-dessus,
  gnd en dessous) : niveau publié = médiane DVD ; base = médiane après dispersion aléatoire des centres ; règle si
  niveau − base > 0,05. Satisfaction UNILATÉRALE plafonnée au niveau publié (plus régulier que les scans n'est jamais
  pénalisé) ; score = moyenne pondérée par niveau − base.
  VALIDATION : témoin 1645 PASS (v2+branches 0,995 ; dispersion auto 0,462 : rangées 0, vdd au-dessus 0,38) ;
  variantes : v2b préféré dans 2 575 circuits, auto 481, égalité 1 397 ; style |Δ| : échelle 0,019, scan 0,042,
  trait épais 0,088 (31 % > 0,1 : point faible, la détection change avec le trait).
  LIMITES : saturation vers 1 pour nos dessins réguliers (sert à repérer les dispersions, pas à départager deux
  dessins propres) ; conçu après l'échec de v2 (risque de biais de conception, mais rien d'ajusté sur 1645) ;
  familles réservées non utilisées pour régler quoi que ce soit (règles tirées des DVD seulement).
  PAS dans auto. Proposition à Eric : mesurer sur le banc par familles l'effet d'un critère « règles » en
  départage après les erreurs check.js (tune seulement), puis décider.
- MESURE BANC (Eric : oui ; tune seulement ; runs `rules0-tune` / `rules1-tune`, AUTO_RULES=1, `lib/layout-rules.js`
  sur la géométrie exacte, table `data/layout-rules.json` par taille seulement) : RÈGLES EN DÉPARTAGE = PIRE.
    banque d'origine (1 214) : zéro erreur 57,7 → 55,6 %, > 3:1 6,8 → 7,5 %, croisements/c 5,4 → 5,7
    open PDK (815)           : zéro erreur 34,4 → 32,9 %, > 3:1 13,3 → 19,1 %, croisements/c 41,8 → 42,4
    choix changés (547/2 029, surtout v4:split → v2 : 198) : zéro erreur 59 → 52 %, > 3:1 3,7 → 14,1 %, crois. 7,8 → 9,2
  Les règles récompensent rangées et alignements, que v2 donne au prix de dessins allongés ; l'élongation n'est pas
  une règle. 1645 : départage sans effet (auto garde v4:one, 1 erreur contre 2). RECOMMANDATION : ne pas adopter tel
  quel (AUTO_RULES reste éteint). Les mesures du banc (erreurs check.py, proportions, croisements) et les règles sont
  deux mesures indirectes de la lisibilité qui se contredisent ; seul l'œil d'Eric peut trancher.
- SÉRIE ERIC `compare/rules-1` (15 paires aveugles, tune) : règles 6, actuel 3, égal 6. VERDICT D'ERIC : les 15 sont
  « entre mauvais et très mauvais, plein de règles de base non suivies ». Le départage est secondaire : c'est le
  moteur qui dessine mal, et check.py/check.js ne voient pas ces défauts (ces dessins ont 0 à 2 erreurs).
  Défauts vus sur nos propres rendus (paires 5 et 10) : PMOS tête en bas (source en bas, VDD sous le transistor) ;
  PMOS en bas de page sous les NMOS ; fil traversant un symbole ; symbole VDD posé sur un fil de net (paire 5, sous
  M2/M3) ; étiquette de composant sur un fil ; extrémité de fil pendante ; fils superposés ; bancs de test (sources,
  sondes) éparpillés au milieu du circuit ; connexions par étiquettes au lieu de fils pour des nets voisins ;
  très longs fils traversant la page.
  PROCHAINE ÉTAPE proposée : faire de ces règles de base des ERREURS de check.js/check.py (vérifiées sur les 15 paires),
  puis corriger le moteur contre elles ; la note du banc n'a de sens qu'une fois ces règles dedans.
- Eric (précisions) : paires différentielles non montrées en miroir ; entrées avec des coudes inutiles ; composants
  seuls dans un coin ; « très brouillon, ne ressemble pas à un schéma d'humain ».
- `lib/basics.js` (règles de base, contrôles par instance) : mos-upside-down, pmos-below-nmos, pair-not-mirrored,
  input-bends, isolated (pièce loin de toute pièce avec qui elle partage un net non-rail : > 3× la médiane et
  > 4 hauteurs). Sur les 30 dessins revus : pmos-below-nmos 28, isolated 25, pair-not-mirrored 3, input-bends 1,
  mos-upside-down 0 (vérifié : les PMOS ont bien la source en haut ; ma lecture visuelle de la paire 10 était fausse).
  Accord avec Eric quand il a choisi un côté : 5 fois le côté préféré a moins de violations, 1 fois l'inverse, 3 égalités.
  Plusieurs dessins jugés mauvais ont 0 violation (paires 4, 9, 13, 15) : règles incomplètes (désordre général,
  coudes, étiquettes sur fils — ces deux derniers existent en AVERTISSEMENTS check.py, ignorés partout).
  SUITE proposée : basics comme métrique du banc + critère d'auto (après les erreurs), puis corriger le moteur
  d'abord sur pmos-below-nmos et isolated (les deux plus fréquents).
- Eric : « fais 1, 2 puis 3 ». FAIT (tune seulement) :
  1. basics dans le banc (colonnes basics/c, clean) et dans auto (après les erreurs) + règle excess-bends (> 2 coudes) ;
  2. place4 POLARITY : un bloc PMOS relié par ses drains à un bloc NMOS rejoint sa colonne, colonnes triées PMOS en haut.
  Runs basics0 (avant) / basics1 (sélection basics) / basics2 (+ polarité) :
    origine  : propres 21,7 → 25,8 → 26,4 % ; basics/c 7,68 → 7,02 → 6,43 ; pmos-below 1,33 → 1,11 → 0,61 ;
               zéro erreur 57,7 → 58,3 → 59,8 % ; > 3:1 6,8 → 6,5 → 5,8 % ; LVS 100 %
    open PDK : propres 6,9 → 10,2 → 11,0 % ; pmos-below 3,34 → 3,15 → 1,06 ; zéro erreur 34,4 → 34,1 → 34,4 %
  Les deux sont ACTIVÉS PAR DÉFAUT (AUTO_BASICS=0 / P4_POLARITY=0 pour revenir). Tests 274/0.
  Restent : coudes en excès (5,2/circuit origine, 13/circuit open PDK : le routeur) et pièces isolées (0,35 / 1,7).
  3. Série aveugle `compare/basics-1` (15 paires tune, ancien auto contre nouveau) prête pour Eric.
- SÉRIE basics-1 : égal 10, nouveau 4, ancien 1. ERIC : « c'est mauvais… il faut envisager d'autres alternatives
  d'algo ». Constat : tout le travail a porté sur JUGER/CHOISIR entre les dessins d'un placeur à règles ; on n'a
  jamais APPRIS le placement sur des dessins humains. Données humaines disponibles (netlist + dessin) :
  AMSNet 734 (images + boîtes + netlists), Masala-CHAI 1 815 images de manuels (netlists AnalogGenie = transcriptions),
  DVD IEEE 13 562 figures (boîtes du détecteur gd1, lectures Ornith ; privé). Les .asc LTspice / .kicad_sch d'origine
  n'ont pas été gardés (seulement les .net). Alternatives proposées à Eric : voir message du 5 oct. (placement par
  l'exemple ; recuit simulé avec objectif appris des dessins humains ; placeur appris (GNN) ; LLM placeur).
- ERIC : « essaye 1 et 2 ».
  DONNÉES HUMAINES : `tools/human/amsnet-layouts.py` → /AI/datasets/human-layouts/amsnet.jsonl : 733/734 schémas AMSNet
  avec position, orientation, miroir de chaque composant RELIÉ à sa référence de netlist (numérotation reproduite
  depuis le carnet AMSNet `reformat_names` ; vérifié à l'œil sur amsnet/233). Couverture « circuit entier »
  (empreinte WL identique) : analoggenie 40/905, openpdk 1/824 → l'option 1 ne servira qu'au niveau des blocs.
  STATISTIQUES : `tools/human/learn-relpos.py` → relpos.json (9 138 paires connectées, 129 couples de rôles) ;
  contrôles : PMOS au-dessus du NMOS de même drain 98 % (323), NMOS à source commune sur une rangée 95 % (352).
  PLACEUR RECUIT `lib/place-sa.js` (moteur « sa ») : part de place2, regroupe symboles et étiquettes avec leur pièce,
  supprime fils et points, recuit sur grille (−log P humain des paires connectées + chevauchement + longueur +
  rappel au centre), paires à source commune en miroir, recâblage MST par net + routePage. Sur les 15 circuits
  revus : LVS 15/15, pmos-below 2, isolés 0 (v4 : 14-25 et 18), mais erreurs check 48 et coudes 96. Paire 10 :
  moitié droite lisible (paire d'entrée en bas, cascodes au-dessus, VDD en haut) ; polarisation à gauche brouillonne.
  Banc tune `sa1-tune` en cours.
- sa v3 (accrochage rangées/colonnes, pénalité croissante hors plage apprise, ordre VDD→masse par distance de graphe,
  paires et miroirs sur une rangée ; commit sur motif-templates). Banc `sa3-tune` (manuels, 1 153 circuits) :
    auto : zéro erreur 60,1 %, err/c 1,39, > 3:1 4,7 %, crois. 5,4, pmos-dessous 0,64, isolés 0,34, coudes 5,3
    sa3  : zéro erreur 29,9 %, err/c 4,12, > 3:1 1,9 %, crois. 8,7, pmos-dessous 0,04, isolés 0,10, coudes 6,2
  → conventions humaines tenues, câblage (traversées, croisements) moins bon.
- Série aveugle `compare/sa-1` (15 circuits de manuels jamais montrés, auto contre sa, LVS vérifié) : DERNIÈRE série
  demandée à Eric avant les 50 notes finales (décision Eric 6 oct.). Ensuite : trancher avec le banc par famille +
  jugement par paires d'Ornith (relatif), sans solliciter Eric. Écrire en français.
- sa-1 (réponses enregistrées) : auto 6, sa 5, égal 4 ; sa gagne sur les circuits moyens/grands (≈ 16 composants),
  auto sur les petits (≈ 9). Eric : « légèrement mieux ».
- Pénalités libavoid coude/croisement exposées (`segmentPenalty`, `crossingPenalty`, env ROUTE_*) : AUCUN effet
  mesuré (1,30 coude/fil) → les coudes viennent de la géométrie des broches, pas du routeur.
- RÈGLES D'ERIC (1 sources-masse en rangée, 2 sources-VDD en rangée, 3 même courant DC en colonne) :
  mesurées EXACTEMENT sur AMSNet (`tools/human/rules-amsnet.py`) : R1 70 % des dessins (hasard 16 %), R2 89 % (15 %),
  R3 83 % des branches (18 %) — mesurée sur le fil drain-source, pas sur le centre (centre : 17 %).
  Sur les figures DVD par structure (`tools/human/rules-dvd.py`, listes RAG, boîtes gd1, hasard uniforme ;
  /AI/datasets/judge/rules-dvd.txt) : R1 39 % (hasard 6 %), R2 31 % (6 %) ; R3 non mesurable sans connectivité.
  Placeur sa : sa4 (R1-R2), sa5 (+ alignement des broches), sa6 (+ R3 sur centres) : zéro erreur 33 / 31 / 30 %
  contre 60 % pour auto ; err/c 4,8 / 4,6 / 6,2 contre 1,4. Conflits : rangée unique trop longue sur les grands
  circuits (> 3:1 1,9 → 5,8 %) ; source dégénérée (corrigé : l'élément du bas de chaque branche va dans la
  rangée) ; colonnes alignées → fils de nets différents superposés (règle 22 : 11 → 26 sur les 15).
  Colonnes sur fil drain-source codées (place-sa.js), pas encore au banc.
- AUTO_SA=1 (recuit comme candidat d'auto, ≤ 40 composants ; run `autosa-tune`) : choisi 111 fois / 1 153 ;
  quasi neutre (propres 24,3 → 25,4 %, pmos-dessous 0,64 → 0,57, zéro erreur 60,1 → 59,7 %). Laissé ÉTEINT.
  CONCLUSION : le goulot est le CÂBLAGE du recuit (MST par net + libavoid sur des broches alignées → superpositions,
  traversées). Piste : câblage dédié à la grille (fils verticaux droits dans les colonnes, rails horizontaux,
  grilles par couloirs), ou placeur constructif « grille des manuels » (rangées rails + colonnes de branches).
- Légalisation (composants empilés par l'accrochage) : 15 circuits erreurs 42 → 23 (règle 22 26 → 8). Banc `sa7-tune` :
  zéro erreur 29,7 % (auto 60,1 %), err/c 5,2 (1,4), > 3:1 7,3 % (4,7), crois. 9,2 (5,4), pmos-dessous 0,06 (0,64).
  > 12 composants : zéro erreur 9 % contre 36 %.
- JUGEMENT PAR PAIRES ORNITH auto contre sa7 (`tools/judge-pairs.mjs --a auto --b sa`, 103 circuits tune, 8/famille,
  deux ordres) : cohérent 66 % ; sa préféré 43, auto 25. Par famille : power sa 8/0, comparator 4/0, opamp 5/2,
  amplifier 4/1 ; filter auto 5/1. Réserve : la consigne cite les conventions que sa applique exprès.
  BILAN des trois instruments : Eric (sa-1) égalité 5/6/4 ; Ornith favorise sa ; le vérificateur favorise
  nettement auto. Recommandation : auto reste le défaut ; sa disponible comme moteur à part ; poursuivre le câblage
  de sa jusqu'à rejoindre auto au vérificateur avant toute bascule.
- Galerie étiquetée `/compare/gallery?batch=exemples-1` (6 circuits, auto et sa côte à côte) pour Eric.
  Défauts révélés (exemple 1, cascode replié) et corrigés : branches DC fusionnées à travers une paire différentielle
  (couper aux nœuds joignant deux sources et aux nets portant une borne externe) ; légalisation sans les symboles
  (deux résistances superposées) ; niveau faussé par le substrat des PMOS et par l'absence de chemin vers la masse.
  Banc `sa8-tune` : zéro erreur 33,7 % (sa7 29,7 ; auto 60,1) ; ≤ 12 composants 53,8 % (46,5 ; auto 79,6) ;
  > 12 : 9,1 % inchangé (auto 36,2) — croisements 17,7 contre 10,9 : chantier suivant = grands circuits.
- CÂBLAGE SUR GRILLE (7 oct., commit e24bd2c, `place-sa.js` étape 4) : chaque liaison de l'arbre d'un net reçoit un
  tracé FIGÉ (`drawioApiFixedRoute` + `drawioApiGridRoute`) quand il en existe un propre — droit, en L, ou échappée de
  la broche + couloir horizontal/vertical — vérifié contre les corps (2 px de marge), les broches étrangères (8 px),
  les fils figés des autres nets (ni parallèle à < 12 px ni contact), les flancs de MOS (channel-hug) et les
  parallèles du même net (règle 29) ; coût = longueur + 2,5/coude + 4 au-delà de 2 coudes ; le reste va à libavoid.
  Corrections trouvées en route : (1) les retournements de sa n'ont JAMAIS été appliqués (style passé en texte →
  clés parasites `0=f;1=l…`, la pièce était quand même décalée) ; (2) boîtes des pièces tournées (résistance à −90 :
  100×20 au lieu de 20×100) dans le chevauchement et la légalisation ; (3) `polishJogs` (route.js) réécrivait les
  tracés figés (détour vérifié → ligne à travers un port) : il saute désormais `drawioApiGridRoute`.
  Ajouts : miroirs à 2 transistors grilles face à face (règle 28), autres transistors grille vers leur commande,
  dipôles verticaux sur rail tournés (masse en bas, VDD en haut), dipôles tournés/miroités vers leurs nets,
  symboles de rail et ports dans l'axe de leur broche, étiquettes de nom sous leur pièce (à gauche d'un dipôle
  vertical), écart minimal 0,5 u entre voisins (SA_GAP), liaison diode grille-drain en dernier recours.
  Interrupteurs : SA_GRID, SA_LANES, SA_MIRROR_FLIP, SA_RAIL_TURN, SA_DIPOLE_TURN, SA_GATE_FACE, SA_RAIL_SYMBOLS (=0).
  Banc `sa9-tune` (1 153 circuits réels, mêmes que sa8 / auto) :
    | | zéro erreur | err/c | crois./c | > 3:1 | basics/c | propres |
    | auto (basics2) | 60,1 % | 1,39 | 5,4 | 4,7 % | 6,7 | 20,6 % |
    | sa8 | 33,7 % | 4,60 | 8,8 | 7,1 % | 7,3 | 10,4 % |
    | sa9 | 55,4 % | 1,12 | 7,4 | 8,6 % | 7,5 | 10,1 % |
  ≤ 12 composants : sa9 73,4 % (auto 79,6) ; > 12 : 33,3 % (auto 36,2 ; sa8 9,1), err/c 2,02 (auto 2,64).
  Toutes les familles progressent en zéro erreur (ex. opamp 29 → 56 %, comparateur 10 → 55 %, référence 8 → 22 %,
  power 0 → 20 %). RESTE : feuilles > 3:1 sur les grands circuits (13,7 % contre 4,1 % : rangées de rails trop longues,
  écart 0,5 u), croisements, coudes en excès (couloirs), « propres » deux fois moins qu'auto ; power et référence faibles.
  Auto reste le défaut ; aucune bascule sans accord d'Eric.
- REPLI EN BANDES (7 oct., commit 5065e72) : sur les grands circuits les rangées de rails donnaient une bande
  très longue (sa9 : 13,7 % de feuilles > 3:1 au-delà de 12 composants). Si largeur > 2,5 × hauteur, le dessin est
  coupé en k bandes empilées ; unités insécables = colonne de branche, paire, miroir à deux ; coupe où le moins de nets
  traversent ; trous resserrés (SA_FOLD=0 pour couper). Banc `sa10-tune` : > 3:1 8,6 → 2,3 % (auto 4,7 %), zéro erreur
  55,4 → 54,6 %, croisements > 12 composants 14,9 → 19,4, pmos-dessous 0,09 → 0,31 (une bande de PMOS sous les NMOS
  de la bande du dessus). Puis correctif : un miroir à deux qui partage sa source avec un 3e transistor était défait
  par la règle « paire » (règle 28 : 38 → 8 sur les 71 cas allongés ; 150 grands circuits : err/c 1,29 → 1,15).
  À FAIRE : croisements entre bandes, coudes, familles power / référence.
- SUITE DU 7 OCT. (après PR #10) : (1) fils droits figés SANS point milieu (`edgeStyle=none`) : le point milieu était un
  sommet, un autre net qui croisait pile là se lisait comme un contact (22-contact) ; (2) rangées des paires et miroirs
  imposées exactement (règle 14 : 21 → 5 sur 150 grands) ; (3) dipôle vertical dont les deux nets partent du même côté
  placé à côté d'eux (wrap-around 32 → 21). Banc `sa11-tune` (fils droits seulement, avant 2 et 3) :
    | | zéro erreur | ≤ 12 | > 12 | err/c | > 3:1 | crois./c | propres |
    | auto | 60,1 % | 79,6 % | 36,2 % | 1,39 | 4,7 % | 5,4 | 20,6 % |
    | sa11 | 62,5 % | 75,8 % | 46,2 % | 0,85 | 2,3 % | 9,2 | 10,1 % |
  sa DÉPASSE auto au vérificateur pour la première fois (zéro erreur, err/c, allongement) ; reste derrière sur les petits
  circuits, les croisements et les règles de base (coudes en excès 6,5/c contre 5,3 : tracés à 3-4 coudes choisis
  seulement quand aucun à 2 coudes n'existe — pénalité plus forte sans effet, c'est le placement). Puis (2)+(3) sur les
  150 grands du jeu de contrôle : zéro erreur 58 → 66 %, err/c 0,91 → 0,75 ; 150 petits : 81 → 82 %.
- JUGEMENT ORNITH PAR PAIRES (relatif, observation seulement) auto contre sa actuel (PR #11), mêmes 103 circuits que
  pour sa7 (`/AI/datasets/judge/pairs-auto-sa12.*`) : cohérent dans les deux ordres 64 % ; sa préféré 37, auto 29
  (sa7 : 43 contre 25). Ornith préfère toujours sa, un peu moins qu'avant (repli en bandes ? bruit : 36 % incohérents).
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
3. **Page de correction** `/correct` prête (lot rf-1), servie en permanence par le portail :
   https://ai-station.tail10543b.ts.net/drawio/correct?batch=rf-1 (l'ancien accès :8443 et `correct-session.sh` ne servent plus).
