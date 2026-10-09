# ÉTAT du chantier « qualité de la génération » — fork drawio (api-server)

Mis à jour le 2026-10-08 (reprise après le redémarrage d'ai-station ; branche et données vérifiées intactes). Un nouveau contexte doit pouvoir reprendre en lisant ce fichier.
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
- sa12 (7 oct., après PR #11) : rangées imposées par groupe entier (miroir à 3), éléments en parallèle (mêmes deux
  bornes) plus pris pour une branche série, symboles de rail en double fusionnés, poussée de colonne qui garde les
  rangées droites. Banc `sa12-tune` :
    | | zéro erreur | ≤ 12 | > 12 | err/c | > 3:1 | crois./c | propres |
    | auto | 60,1 % | 79,6 % | 36,2 % | 1,39 | 4,7 % | 5,4 | 20,6 % |
    | sa12 | 70,7 % | 81,9 % | 56,9 % | 0,63 | 2,3 % | 9,2 | 10,4 % |
  sa devant auto partout au vérificateur. RESTE : croisements (9,2 contre 5,4 ; un coût plus fort sur les tracés figés
  est sans effet : ils viennent de l'arbre de chaque net et du placement), coudes en excès, cible d'Eric ≥ 80 % sans
  erreur pas encore atteinte (70,7 %).
- CONTRÔLE DE SUR-AJUSTEMENT (7 oct., demande d'Eric ; code de la PR #12 ; runs `ovf-{auto,sa}-{test,holdout-family}`
  sur la banque d'origine, `ovf-*-holdout-openpdk` ; 16 variantes de scellés refusées par lib/sealed.js, aucun échec LVS) :
    | jeu | moteur | n | zéro erreur | ≤ 12 | > 12 | err/c | > 3:1 | crois./c |
    | réglage | auto | 1153 | 60,1 % | 79,6 % | 36,2 % | 1,39 | 4,7 % | 5,4 |
    | réglage | sa | 1153 | 70,7 % | 81,9 % | 56,9 % | 0,63 | 2,3 % | 9,2 |
    | test | auto | 720 | 57,2 % | 79,4 % | 32,0 % | 1,87 | 6,4 % | 5,7 |
    | test | sa | 720 | 71,0 % | 85,1 % | 54,9 % | 0,74 | 2,4 % | 9,8 |
    | jamais vues | auto | 937 | 29,6 % | 68,8 % | 28,9 % | 2,89 | 2,3 % | 14,5 |
    | jamais vues | sa | 937 | 33,9 % | 68,8 % | 33,3 % | 2,30 | 0,1 % | 26,6 |
  Jamais vues par famille : sampler-sc (626) auto 35,6 / sa 36,4 % ; regulator (306) 17,3 / 28,8 %. Open PDK jamais
  vues (345, surtout data-converter 303) : zéro erreur auto 35,1 / sa 43,8 %, MAIS err/c 38 / 63 (très grands
  convertisseurs : sa y fait bien plus d'erreurs), > 3:1 12,5 / 3,8 %.
  Écart réglage → test : avant (2 oct., auto) 45 % → 49 % ; aujourd'hui auto 60,1 → 57,2 %, sa 70,7 → 71,0 %.
  CONCLUSION : pas de sur-ajustement visible sur le jeu de test (sa garde son niveau, +14 points sur auto). Sur les
  familles jamais vues, le gain de sa fond (+4 points au lieu de +11/+14) et les très grands convertisseurs open PDK
  sont mal dessinés : les réglages valent surtout pour les structures déjà vues.
- Session RAG (7 oct.) : passe de nuit sur GPU 0 seulement (MinerU, lectures, descriptions, index des figures) ; GPU 1
  reste à drawio. Rangs des figures « natif » changés dans figures.sqlite (37 883 avec cadre) ; nos étiquettes et
  boites-ornith.jsonl non touchés ; ~6 400 nouveaux schémas DVD lisibles annoncés plus tard par l'orchestrateur.
- sa COMME CANDIDAT D'AUTO (demande d'Eric, 7 oct. ; `AUTO_SA` actif par défaut, `AUTO_SA=0` pour couper,
  `AUTO_SA_MAX=N` pour limiter la taille ; runs `autosa2-*`, scellés refusés par lib/sealed.js : 49) :
    | jeu | auto | sa | auto+sa (zéro erreur ; err/c ; propres) |
    | réglage (1153) | 60,1 % ; 1,39 ; 20,6 % | 70,7 % ; 0,63 ; 10,4 % | 68,9 % ; 0,82 ; 23,8 % |
    | test (720) | 57,2 % ; 1,87 ; 21,5 % | 71,0 % ; 0,74 ; 10,8 % | 66,2 % ; 0,94 ; 23,9 % |
    | jamais vues (937) | 29,6 % ; 2,89 | 33,9 % ; 2,30 | 39,2 % ; 1,81 |
    | conv./PDK jamais vus (345) | 35,1 % ; 38,4 | 43,8 % ; 62,9 | 46,1 % ; 24,6 |
  auto+sa bat auto PARTOUT et sa sur les familles jamais vues, les convertisseurs, les dessins « propres » et les
  croisements ; MAIS sa seul garde plus de dessins sans erreur sur réglage et test (−2 et −5 points). Cause : l'arbitre
  interne d'auto (check.js) ne juge pas comme check.py — 216 circuits de réglage où auto préfère un candidat que
  check.py juge pire que sa (170 l'inverse ; erreurs en cause : through, 29, 22-contact, pin-clearance) ; le départage
  « règles de base » favorise aussi les autres candidats (sa a plus de coudes). auto+sa choisit sa dans 25-42 % des cas.
  Temps (auto+sa) : médiane 0,6-1,9 s, 90e centile 4-6 s (52 s sur les PDK) ; sa seul : 45 s à 150 composants, le
  maximum de 958 s vient des autres candidats d'auto. Piste : aligner check.js sur check.py, puis remesurer.
- ARBITRE D'AUTO ALIGNÉ SUR check.py (Eric : option a, 8 oct. ; PR #13 fusionnée avant) : auto fait compter les erreurs
  de chaque candidat par tools/check.py (en parallèle ; repli check.js si python échoue ; AUTO_JUDGE=js pour revenir).
  Runs `autosa3-*` (scellés refusés : 49, aucun échec LVS) :
    | jeu | auto (avant) | sa | auto+sa, arbitre check.py |
    | réglage (1153) | 60,1 % ; 1,39 | 70,7 % ; 0,63 | 85,9 % ; 0,26 (≤ 12 : 95,8 % ; > 12 : 73,7 %) |
    | test (720) | 57,2 % ; 1,87 | 71,0 % ; 0,74 | 86,4 % ; 0,33 |
    | jamais vues (937) | 29,6 % ; 2,89 | 33,9 % ; 2,30 | 67,4 % ; 0,69 |
    | conv./PDK jamais vus (345) | 35,1 % ; 38,4 | 43,8 % ; 62,9 | 53,0 % ; 22,3 |
  (zéro erreur ; err/c). > 3:1 : 2,5 / 4,2 / 0,6 / 6,1 % ; propres 24,9 % (auto 20,6). sa choisi dans 38-48 % des cas.
  Temps : médiane 1,1-2,6 s, 90e centile 5-9 s (63 s PDK), maximum 1 217 s sur un convertisseur de 147 composants.
  RÉSERVE : le critère de choix et la mesure sont maintenant le même vérificateur ; « zéro erreur » n'est plus une
  mesure indépendante de la lisibilité (seuls l'œil d'Eric, les 50 notes finales et le juge relatif d'Ornith le sont).
  Cible d'Eric ≥ 80 % sans erreur atteinte sur réglage et test, pas sur les familles jamais vues.
- Étape intermédiaire AVANT (c) (orchestrateur, Eric ne veut pas de longues annotations) : PSEUDO-ÉTIQUETTES —
  (1) demander à Ornith des boîtes approximatives en plus des composants, ou utiliser ses décomptes par type comme
  contrainte faible ; (2) auto-apprentissage : garder les détections confiantes ET cohérentes avec les décomptes
  d'Ornith, réentraîner, itérer ; mesurer sur un petit jeu DVD vérifié à part. Eric seulement en dernier recours,
  lot court, interface simple.

- REPRISE DU 8 OCT. (redémarrage d'ai-station ; décisions d'Eric : PR #13 et #14 fusionnées, auto+sa par défaut,
  arbitre check.py) : service drawio-api revenu tout seul (200 en local et via le portail).
  (a) BUDGET DE TEMPS d'auto (commit 3fb553f, `AUTO_BUDGET_MS`, 60 s par défaut) : passé le budget, auto garde le
  meilleur dessin déjà fini (les candidats en cours continuent en tâche de fond sans être attendus). Mesure sur les 345
  convertisseurs PDK (339 communs, comparés à `autosa3-holdout-openpdk`, même code sans budget) :
    | | zéro erreur | err/c | > 3:1 | médiane | 90e c. | max | total | budget atteint |
    | sans budget | 53,7 % | 17,2 | 5,6 % | 2,5 s | 57 s | 637 s | 124 min | — |
    | budget, un seul fil JS | 52,5 % | 71,5 | 10,6 % | 2,5 s | 66 s | 216 s | 100 min | 31 |
    | budget + threads | 53,7 % | 17,9 | 7,1 % | 3,8 s | 34 s | 85 s | 59 min | 11 |
  Deux défauts trouvés en mesurant : (1) les candidats d'auto étaient des promesses sur UN seul fil : au budget,
  seul v2 (rapide, médiocre) avait fini sur les gros convertisseurs → erreurs ×4 ; corrigé : un worker thread par
  candidat dès 30 composants (`AUTO_THREADS=0` pour couper, `AUTO_THREADS_MIN`), les threads non finis sont tués au
  budget ; (2) le worker de routage libavoid comptait son délai de 6 s dès la mise en file, et chaque expiration
  faisait échouer toute la file (routes ratées quand les candidats routent ensemble) ; corrigé : file d'attente, délai
  pendant le calcul seulement (lib/route.js). Avec les threads : 3 circuits sur 339 un peu moins bons (144, 150 et
  128 composants), aucun meilleur ; temps total divisé par deux. Runs `budget60{,q,t}-holdout-openpdk`.
  (b) DVD NATIF (livraison du RAG `schemas-natif-2026-10-08.jsonl`, 10 404 lectures DVD) : normaliseur strict
  `tools/import-dvd-natif.py` → 1 475 netlists gardées (`bank/dvd-natif`, `manifest-dvdnatif.jsonl`), puis FILTRE
  EXPLICITE DES SCELLÉS `tools/filter-sealed.mjs --source dvd-natif` (lib/sealed.js en forme stricte, règle de
  motifs appliquée toutes familles confondues ; lib/invariant.js empreinte des documents dessinés et dépend des refdes,
  son équivalent pour une netlist est l'empreinte WL de sealed.js) : 0 scellé exact, 47 variantes proches refusées
  → `bank/excluded-dvd-natif.jsonl`, lu par `bankExclusions()` comme `excluded.jsonl`. Reste 1 401 (réglage 767,
  test 507, familles jamais vues 127 : data-converter 100, regulator 27).
  Banc (runs `dvd-{autoold,sa,auto}`, filtrés dans `dvd-*-f`) — zéro erreur ; > 3:1 ; err/c ; crois./c :
    | jeu | auto d'avant | sa | auto d'aujourd'hui |
    | réglage (767) | 59,1 % ; 34,9 % ; 1,83 ; 2,6 | 74,2 % ; 10,7 % ; 1,51 ; 4,7 | 87,1 % ; 16,9 % ; 0,71 ; 3,0 |
    | test (507) | 57,6 % ; 32,7 % ; 2,00 ; 2,7 | 80,1 % ; 12,6 % ; 0,57 ; 4,4 | 90,5 % ; 17,2 % ; 0,48 ; 3,3 |
    | jamais vues (127) | 58,3 % ; 34,6 % ; 1,63 ; 2,3 | 78,0 % ; 11,8 % ; 1,59 ; 5,5 | 85,0 % ; 15,0 % ; 0,34 ; 3,3 |
  Petits circuits (médiane 0,3 s). Cible ≥ 80 % sans erreur tenue partout, y compris jamais vues ; MAIS feuilles
  > 3:1 à 15-17 % (cible ≤ 10 %) : sur ces petits circuits lus, auto préfère souvent une rangée allongée. À traiter.
  (c) Juge par paires corrigé : une panne d'Ornith devient un échec (avant : compté « incohérent » — le run de la nuit,
  13 paires, en souffrait), dessins identiques mis à part (`same`), premier ordre tiré au hasard par circuit.
  JUGE ORNITH PAR PAIRES « auto d'avant » (sans sa, arbitre check.js) contre « auto d'aujourd'hui » (+sa, arbitre
  check.py), 15 circuits par famille, les deux ordres, premier ordre au hasard (`/AI/datasets/judge/pairs3-*`) :
    | jeu | circuits | identiques | paires | cohérentes | préfère avant | préfère aujourd'hui |
    | réglage | 275 | 105 | 167 | 57 % | 48 | 48 |
    | test | 266 | 95 | 170 | 57 % | 50 | 47 |
    | jamais vues | 45 | 16 | 29 | 48 % | 4 | 10 |
  Biais de position : Ornith choisit le 2e dessin 65 % du temps ; 43 % d'incohérences. Globalement ÉGALITÉ (102 contre
  105) : le gain d'auto au vérificateur (60 → 86 % sans erreur) ne se voit pas à l'œil d'Ornith. Par famille : aujourd'hui
  devant sur power (16-3), regulator (6-0), reference (9-4), opamp, et sur les circuits ≥ 12 composants (74-55) ;
  avant devant sur VCO (12-3), filter (9-2), lna (7-2), clock (7-2), oscillator : petits circuits RF où sa est souvent
  élu. Observation seulement (règle d'Eric) ; piste pour la suite : croisements et placement des petits circuits RF.

- NOTE D'ERIC, SÉRIE 1 (8 oct., /drawio/eric-paires, 10 paires « auto d'avant » contre « auto d'aujourd'hui »,
  circuits où Ornith hésitait) : avant 6, aujourd'hui 1, égal 3. ORCHESTRATEUR : ne rien fusionner qui change le choix
  d'auto (y compris la pénalité d'allongement, codée, en mesure) avant l'analyse de la série 2 (avec figure de
  référence et commentaires dictés : /AI/datasets/judge/compare/eric-paires-2).
  Analyse (`tools/analyse-pairs.mjs`, dessins refaits identiques à ceux vus, `eric-paires/analyse.json`) sur les 6 paires
  préférées « avant » : erreurs du vérificateur PLUS nombreuses 6/6 (1,2,4,10,7,4 contre 0,0,0,3,4,0) ; fil total par
  composant plus COURT 6/6 (−2 à −30 %) ; fils longs moins nombreux 5/6 ; croisements moins nombreux 4/6 ; feuille plus
  allongée 3/6 (jusqu'à 2,8:1). Les mesures des règles d'Eric (sources à la masse / au VDD sur une rangée, charge dans la
  colonne de son transistor, branche en colonne) ne séparent PAS les deux côtés ; à l'œil (paires 3 et 7), l'avant
  dessine chaque étage en colonne VDD → charge → transistor → masse et les étages de gauche à droite dans l'ordre du
  signal, l'aujourd'hui aligne les transistors mais pend les charges à un bus commun avec de longs fils aller-retour.
  CONCLUSION PROVISOIRE (n = 6) : le choix calé sur check.py sacrifie la longueur de fil et l'enchaînement des étages ;
  « sans erreur » au vérificateur ne mesure pas la lisibilité pour Eric ; la pénalité d'allongement va peut-être contre
  son goût. Pistes à valider sur la série 2 : départager par la longueur de fil, ou ne plus laisser check.py primer.

- RÈGLE D'ALLONGEMENT (Eric, 8 oct. ; `AUTO_ASPECT=1`, DÉSACTIVÉE par défaut sur consigne de l'orchestrateur jusqu'à la
  série 2) : à erreurs égales, une feuille ≤ 3:1 d'abord. Runs `aspect{0,1}-{tune,test,holdout,dvd,pdk}` (même code,
  scellés refusés : 46 variantes) — zéro erreur ; err/c ; > 3:1 ; crois./c ; fil/c :
    | jeu | avant | après |
    | réglage (1212) | 85,1 % ; 0,30 ; 4,3 % ; 7,1 ; 580 | 85,1 % ; 0,30 ; 0,9 % ; 7,2 ; 583 |
    | test (772) | 86,0 % ; 0,35 ; 5,1 % ; 7,6 ; 572 | 86,0 % ; 0,35 ; 0,8 % ; 7,6 ; 576 |
    | jamais vues (936) | 67,4 % ; 0,69 ; 0,9 % ; 19,0 ; 866 | 67,4 % ; 0,69 ; 0,2 % ; 19,0 ; 866 |
    | DVD natif (1401) | 88,4 % ; 0,27 ; 21,1 % ; 3,4 ; 529 | 88,4 % ; 0,27 ; 6,6 % ; 3,4 ; 536 |
    | PDK (343) | 53,1 % ; 29,4 ; 7,6 % ; 62,0 ; 937 | 53,1 % ; 20,2 ; 3,5 % ; 61,7 ; 925 |
  Objectif ≤ 10 % tenu partout, aucune erreur perdue (règle placée après le nombre d'erreurs) ; fil +0,5 à +1,3 % (sauf
  PDK : −1 %, et err/c PDK 29 → 20 = effet du budget de temps, pas de la règle). Choix changés : 39 à 398 par jeu.
  MAIS Eric a préféré la feuille plus allongée dans 3 des 6 paires de la série 1 : à n'activer qu'après la série 2.

- BANQUE NETTOYÉE (décision d'Eric, 9 oct. ; `tools/clean-bank.mjs` puis `inventory-bank.mjs`) : les entrées AnalogGenie à
  bloc mis à plat (noms d'instance en double dans la netlist d'ORIGINE ; la copie de la banque les avait renommés,
  MM0_2) sont RETIRÉES de la mesure : 2 305 entrées, `bank/excluded-analoggenie-flat.jsonl` (lu par bankExclusions).
  Les entrées à image partagée restent comme netlists (image jamais affichée). FAMILLES JAMAIS VUES RECONSTRUITES avec
  des circuits propres d'open PDK et du DVD (jamais réglés dessus) + les AnalogGenie propres ; 27 circuits
  sample-and-hold / capacités commutées réétiquetés `sampler-sc` (légende DVD explicite, nom de cellule open PDK :
  `bank/family-overrides.jsonl`). NOUVELLE RÉFÉRENCE (runs `clean1-*`, scellés refusés 50, échecs 0) :
    | jeu | n | zéro erreur | err/c | > 3:1 | crois./c | ≤ 12 comp. | > 12 comp. |
    | réglage (banque d'origine propre) | 822 | 89,9 % | 0,21 | 5,8 % | 2,9 | 94,6 % | 70,4 % |
    | test (banque d'origine propre) | 519 | 90,6 % | 0,28 | 6,6 % | 3,5 | 96,3 % | 71,2 % |
    | jamais vues reconstruites | 542 | 62,7 % | 30,0 | 9,8 % | 42,2 | 93,0 % | 43,2 % |
  Jamais vues par famille : regulator 74 → 62,2 % (DVD 77,8 %, open PDK 47,4 % avec 108 err/c : gros régulateurs à
  blocs) ; sampler-sc 75 → 72,0 % ; data-converter 393 → 61,1 % (DVD 88,5 %, open PDK 53,2 %). Avant (936, dont 93 %
  d'AnalogGenie aplatis) : 67,4 % — l'ancien chiffre surestimait la généralisation sur des circuits propres. Le seul
  dessin LVS faux (une lecture DVD de 6 MOS aux bornes incohérentes) l'était déjà dans tous les runs précédents.
  Faiblesse claire : les GRANDS circuits jamais vus (> 12 composants : 43 % sans erreur), surtout open PDK.

- POURQUOI LES GRANDS OPEN PDK JAMAIS VUS ÉCHOUENT (analyse CPU, 9 oct., run `clean1-holdout`, choix d'auto inchangé) :
  251 circuits open PDK > 12 composants, 37 % sans erreur ; erreurs très concentrées (les 10 % pires = 91 % des
  erreurs ; > 100 composants : 36 circuits, 14 819 erreurs sur 16 204, budget de 60 s atteint pour 21).
  CAUSE 1 — pas des schémas : 572 des 1 705 netlists open PDK sont des EXTRACTIONS DE LAYOUT (noms de nets
  géométriques `a_130_0#` de Magic, pex / mag / lvs / flat / lay dans le nom, capacités parasites ; ex. un OTA 6T
  « pex » à 62 capacités sur VOUT, une source de courant en 132 doigts PMOS série) et 154 des HIÉRARCHIES APLATIES
  (`Xx1.x5/A`). Au-delà de 50 composants : extractions 50 circuits, 2 % sans erreur, 90 % des erreurs ; un dessinateur
  ne dessine jamais une extraction. Il y a aussi des bancs de test (tb_*) avec sources et instruments.
  CAUSE 2 — encombrement réel sur les vrais grands schémas (79 > 25 composants : 33 % sans erreur) : règles 22-contact,
  22 (nets parallèles trop proches), through, pin-clearance, wrap-around ; 97 croisements/circuit ; sa élu 43 fois sur
  79. L'espacement ne croît pas avec le nombre de nets ; pas de dessin par blocs (sous-circuits en boîtes).
  PROPOSITIONS (à Eric) : (a) retirer les extractions et les hiérarchies aplaties d'open PDK de la mesure, comme les
  AnalogGenie aplatis ; (b) pour les vrais grands schémas : canaux de routage proportionnels au nombre de nets, ou
  dessin hiérarchique (blocs) — chantier de placement, après la série 2.

- RÉFÉRENCE ACTUELLE (9 oct., après retrait d'open PDK hors schémas, décision d'Eric : 549 extractions, 156 hiérarchies
  aplaties, 202 bancs de test → `excluded-openpdk-nonschema.jsonl` ; restent 798 schémas open PDK). Réglage et test
  inchangés (banque d'origine propre, sans open PDK) : 89,9 % et 90,6 % sans erreur. JAMAIS VUES (recalcul exact
  sur `clean1-holdout` sans les exclus, chaque circuit étant dessiné indépendamment) :
    | | n | zéro erreur | err/c | > 3:1 | crois./c | ≤ 12 comp. | > 12 comp. |
    | avant retrait | 542 | 62,7 % | 30,0 | 9,8 % | 42,2 | 93,0 % | 43,2 % |
    | après retrait | 377 | 74,8 % | 2,68 | 11,1 % | 21,2 | 92,5 % | 57,4 % |
  Par famille : regulator 58 → 72,4 % ; sampler-sc 70 → 71,4 % ; data-converter 249 → 76,3 %. Aucun LVS faux.
  Feuilles > 3:1 à 11,1 % (cible ≤ 10 %) : la règle d'allongement est désactivée en attendant la série 2.

- SÉRIE 2 D'ERIC (9 oct., 10 paires avec figure de référence et commentaires dictés ; `eric-paires-2/answers.jsonl`,
  `analyse.json`) : aujourd'hui 5, avant 4, égal 1 (séries 1+2 : avant 10, aujourd'hui 6, égal 4).
  Pouvoir prédictif sur les 16 paires tranchées : « vérificateur d'abord » (choix actuel d'auto) 4 justes + 3 égalités ;
  « fil le plus court » 12 ; « feuille ≤ 3:1 d'abord, puis fil le plus court » 13. Les feuilles très allongées perdent
  (8:1, 9,5:1, 27:1), 2,8:1 passe.
  Commentaires d'Eric par thème : (A) LECTURES FAUSSES vues grâce à la référence : « il n'y a que des NMOS », « la
  grille de M6 est polarisée, pas à la masse », « tu as manqué le transformateur, les inductances sont couplées »,
  « il manque la source de courant », « pas de transistors, juste des sous-blocs », « schéma trop compliqué, retire-le » ;
  (B) RÈGLES DE DESSIN : tout entre le rail du haut et le rail du bas, ne pas mélanger les fonctions ; jamais de
  composants les uns sur les autres ; éviter les coudes en alignant (résistance) ; miroirs et symétrie horizontale des
  MOS ; étages d'entrée à gauche, de sortie à droite ; empilements verticaux (M3, M4) ; dessin par sous-blocs.

- DÉCISION D'ERIC (9 oct.) : PÉRIMÈTRE ≤ 25 COMPOSANTS pour la mesure, les séries et les réglages (les > 25 restent
  dans la banque, hors périmètre ; sous-blocs et canaux proportionnels REPORTÉS). « La reconnaissance topologique est
  toujours la clef d'un schéma lisible. » Inventaire sur les 3 264 circuits ≤ 25 de la banque propre : 46 % des
  composants (53 % des transistors) dans un motif AVEC recette de placement ; étages élémentaires détectés SANS recette
  (source commune 1 053, grille commune 989, suiveur 1 109, interrupteur 506, BJT résistif 148 composants) ; charges et
  polarisation rattachées à aucun étage (2 107 R, 1 503 C, 475 L, 393 sources I hors motif) ; pas de graphe d'étages ;
  sa (élu ~40 %) ignore le registre de motifs. PLAN envoyé à l'orchestrateur : A périmètre ≤ 25 dans les outils +
  référence ; B reconnaissance d'étages (couverture ≥ 90 % des transistors) ; C placement par le graphe d'étages
  (nouveau candidat) ; D nouveau critère d'auto ; E série 3 (10 paires ≤ 25, netlists exactes ou lectures vérifiées).
  Activation de C et D seulement avec l'accord d'Eric.

- RÉFÉRENCE ≤ 25 (ÉTAPE A, 9 oct. ; DVD natif EXCLU — lecture-1 non fiable selon le RAG ; netlists exactes seulement :
  AMSNet, AnalogGenie propres, LTspice, KiCad, schémas open PDK ; runs `p25-*`, les DVD retirés du résultat ;
  scellés refusés 60, aucun échec, aucun LVS faux) :
    | jeu | n | zéro erreur | err/c | > 3:1 | crois./c | fil/c |
    | réglage | 1 021 | 91,8 % | 0,12 | 5,9 % | 2,5 | 454 |
    | test | 648 | 90,3 % | 0,20 | 7,6 % | 3,0 | 456 |
    | jamais vues | 169 | 84,6 % | 0,25 | 5,9 % | 5,3 | 606 |
  Jamais vues par famille : data-converter 104 → 88 %, regulator 27 → 78 %, sampler-sc 38 → 79 % (petit jeu). Familles
  faibles : oscillateur (68 % réglage, 81 % test), filtre (77 %), comparateur (79-86 %), PLL (80 %) ; KiCad 70-85 %.
  RAPPEL : « zéro erreur » au vérificateur ≠ lisibilité pour Eric (séries 1-2).
  Recherche open source pour B : `references/ANALYSE.md` (ALIGN-public, MAGICAL, pyckt, asg, EEschematic) — aucun ne
  reconnaît les étages ni n'ordonne le signal ; idées reprises : graphe à arêtes = ensembles de broches, fusion
  parallèle/série, correction D/S depuis les rails (ALIGN) ; meilleur match mutuel et auto-symétriques (MAGICAL) ;
  rang = plus long chemin depuis les entrées (asg) ; blocs typés à ports sémantiques (pyckt, idée seulement).

- ÉTAPE B — RECONNAISSANCE DES RÔLES ET DES ÉTAGES (`lib/stages.js`, outil `tools/stages-eval.mjs` ; analyse pure,
  aucun dessin changé) : rôle de chaque composant (paire, paire croisée, miroir réf./sortie, cascode, queue, source de
  courant, source commune, grille commune, suiveur, interrupteur, inverseur, diode, varactor ; charge, dégénérescence,
  contre-réaction, liaison, polarisation, découplage), branches DC rail → rail (chemins bornés), étages = branches
  liées par un nœud drain/source commun (paires et paires croisées réunies ; miroir séparé de sa référence), ordre
  du signal = plus long chemin depuis les étages d'entrée (sortie drain → grille, à travers une liaison).
  Couverture (1 777 circuits ≤ 25, netlists exactes) : 100 % des transistors ont un rôle, 81 % des composants dans un
  étage — chiffre trompeur (un repli donne toujours un rôle). JUSTESSE vérifiée à la main sur 30 circuits avec figure
  (15 AMSNet, 15 AnalogGenie à image propre) : 15 justes, 11 en partie, 4 faux (dont 2 réseaux passifs / modèle petit
  signal). Corrigés pendant le contrôle : sources de courant idéales (queue, pas « dégénérescence »), broche de
  polarisation externe (Vb) distinguée d'une entrée (position de charge), miroir cascode basse tension, paire croisée
  avant paire différentielle, varactors, horloges VCLK/VLATCH (interrupteurs), entrée en courant IIN.
  RESTE : paires à sources séparées (dégénérescence commutée, entrée via interrupteurs), suiveur à contre-réaction
  locale (FVF), comparateurs dynamiques / verrous, références BJT (bandgap), boucles d'auto-polarisation.

- ÉTAPE B, 2E PASSAGE (9 oct.) : structures ajoutées — paires à sources séparées (dégénérescence, échelle commutée,
  entrée de comparateur dynamique via interrupteurs), suiveur à contre-réaction locale (FVF ; distingué du miroir
  cascode basse tension par la grille), BJT en diode (bandgap), commandes VCONT/CTRL (interrupteurs), source sans forme
  d'onde reliée seulement à des grilles = entrée (pas un rail), « cascode » à drain sur rail = suiveur, boucle passant
  par une diode = miroir (pas paire croisée), paire différentielle exclue si une grille est une polarisation EXPLICITE
  (rail, nom, diviseur vers les rails, grille partagée hors paire), diviseur venant d'une sortie = contre-réaction,
  « miroir » à grille sur rail = charges en diode.
  2E CONTRÔLE À LA MAIN sur 30 AUTRES circuits avec figure : 20 justes, 7 en partie, 3 faux — objectif 24 NON atteint
  (et le chiffre inclut des corrections faites pendant le contrôle). Échecs restants : cœur d'oscillateur BJT à
  inductances d'émetteur, charges commandées par une CMFB résistive, figures d'analyse de bruit, broche numérotée
  ambiguë Vb/Vin (AMSNet, sans noms : indécidable), une netlist AMSNet fausse (PMOS déclaré NMOS).
  Test navigateur intermittent (`eda-validate plugin via /editor: reroute…`, délai de 60 s) : à surveiller.

- ÉTAPE C — MOTEUR « stages » (9 oct. ; `lib/place-stages.js`) : placement initial tiré de la lecture topologique
  (étages de gauche à droite par rang, polarisation à gauche, une colonne par branche DC, rail haut en haut, parties
  hors branche près de ce qu'elles relient), affiné et câblé par place-sa (`opts.saInit`, recuit court et froid).
  Corrections de `stages.js` pour les colonnes : une branche s'arrête sur une broche de courant (IB1 d'AnalogGenie),
  le courant ne remonte pas (on entre dans un PMOS par la source, dans un NMOS par le drain), chaînes lues depuis la
  masse alignées par le bas. SEUL, il est MOINS bon que l'auto actuel sur réglage ≤ 25 (lecture sûre, 875 circuits) :
  zéro erreur 78,7 % contre 93,6 %, fil +40 %, croisements et coudes +45 % ; l'espacement n'y change rien (la finition
  de place-sa réétale) ; LVS toujours juste. Candidat d'auto derrière `AUTO_STAGES=1` (désactivé), seulement si la
  lecture est sûre (`stagesConfident`).
- ÉTAPE D — CRITÈRE `AUTO_CRITERION=eric` (désactivé) : pas d'erreur grave (superposition, coude sur un autre net, fil à
  travers un composant), puis feuille ≤ 3:1, puis fil le plus court, puis vérificateur. Banc ≤ 25 (runs `dE-*`, `dES-*`) :
    | réglage (1 021) | actuel | D | D + étages |
    | zéro erreur | 91,8 % | 74,4 % | 74,8 % |
    | erreurs graves | 1,0 % | 0,3 % | 0,3 % |
    | > 3:1 | 5,9 % | 0,5 % | 0,4 % |
    | fil/c | 454 | 371 | 368 |
    | croisements/c | 2,50 | 2,43 | 2,39 |
  Test (648) : même tendance (fil 456 → 387, > 3:1 7,6 → 0,9 %, graves 2,2 → 0,8 %, zéro erreur 90,3 → 77,8 %).
  D+étages change 70 % des dessins ; le moteur stages est choisi dans ~4 % des cas.
  Déterminisme corrigé : à égalité, auto garde le candidat de l'ordre fixe (avant : le premier FINI, le même circuit
  pouvait être dessiné autrement d'un tirage à l'autre ; c'était la règle documentée « puis le candidat le plus tôt »).
- SÉRIE 3 PRÊTE (`/drawio/eric-paires` → `eric-paires-3`) : 10 paires ≤ 25 « auto actuel » contre « D + étages »,
  netlists exactes avec figure de référence (AnalogGenie à image propre ; AMSNet lues dans le zip), familles
  analogiques, 3 paires dessinées par le moteur stages ; jamais de scellé.

- PASSE DE REDRESSEMENT (Eric, 9 oct., capture iPhone « 5 coudes évitables » ; `lib/straighten.js`, outil
  `tools/straighten-eval.mjs` ; PAS activée dans auto, appliquée aux pages de lectures) : coude ÉVITABLE = coude d'un
  fil entre deux broches d'un même net décalées de ≤ 1 pas (½ taille médiane) sur un axe. Passe gloutonne après
  placement : déplacer d'un pas au plus un symbole / port, puis un dipôle, puis un transistor (avec ses satellites :
  rail, masse, port reliés à lui seul), ou RETOURNER un transistor (colonne de queue sous un transistor retourné) ;
  rangées et colonnes de transistors reliés jamais cassées ; recherche à deux coups ; chaque coup est validé par
  `tools/check.py` (fils re-routés seulement autour des pièces déplacées, fil droit figé quand les broches sont
  alignées, points de contact là où check.py les demande ; coup refusé si les erreurs ou une seule erreur grave —
  diagonale, traversée, contact, superposition — augmentent). Étiquettes des transistors collées au trait
  drain-source, côté opposé à la grille. Banc ≤ 25 (200 dessins d'auto) : coudes évitables 9,9 → 6,0 /dessin,
  coudes totaux 20,3 → 16,4, 147 dessins améliorés et aucun dégradé, erreurs check.py 0,09 → 0,07, LVS intact,
  0,6 s/dessin. Lectures d'Eric redessinées : lot 1 (8) 77 → 15 coudes évitables ; échantillon (20) 340 → 247.
  Le zéro n'est PAS atteint sur les lectures de 15-25 composants (décalages > 1 pas = placement, ou coups refusés
  par check.py) ; les verrous de lot 1 et le verrou CML de la capture sont propres.

- SÉRIE 3 D'ERIC (9 oct., « auto actuel » contre « D + étages », 10 paires ≤ 25, netlists exactes AnalogGenie) :
  D + étages 4, actuel 3, égal 3. Paires dessinées par le moteur stages : 2 préférées (PLL 7 comp., ampli 4), 1 jugée
  « nulle » des deux côtés (PA 15 comp. : 26 croisements côté stages). Commentaires : « pénalité à chaque coude à 90° »,
  « aligner R et MOS réduit le coude », « deux nets différents n'ont pas le droit d'être l'un sur l'autre » (règle à
  ajouter), « valeurs fausses, pas 1k mais valeurs littérales » (AnalogGenie : valeurs inventées à l'import), « VCO :
  croisement à 45° grille-drain » (paire croisée), « transistor entre les deux groupes de résistances », 3 paires
  « très mauvais » des deux côtés (comparateur 14, PA 15, PLL 9).
  PRÉDICTEURS sur les 23 paires tranchées des séries 1-3 : vérificateur d'abord 6 justes / 9 faux / 8 égalités ;
  fil le plus court 16/7 ; feuille ≤ 3:1 puis fil (critère D) 17/6 ; ≤ 3:1 puis coudes par fil + 0,1·croisements
  17/6 ; série 3 seule : coudes par fil 6/7.

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
