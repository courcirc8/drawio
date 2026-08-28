# Registre des règles — entraînement sur schémas publiés

Chaque exercice : figure publiée → netlist lue par le LLM → génération
automatique (`?optimize=N`) → comparaison côte à côte → règles extraites +
poids questionnés. Étalons : reproduction VCO Hajimiri-Lee (LVS 8/8).

## Poids courants et leur justification (questionnés à chaque exercice)

| Poids | Valeur | Justification | Doutes ouverts |
|---|---|---|---|
| crossing | 6 | un croisement gêne la lecture | exempté pour les diagonales volontaires (X publiés) |
| through | 14 | traverser un corps est inacceptable | — |
| bend | 0.15 | un L est souvent inévitable | trop faible pour punir les zigzags ? couvert par excess_bend |
| excess_bend | 1.4 | zigzags d'évitement inutiles | le minimum géométrique (0/1) ignore les T |
| too_close | 5 | un schéma respire | marge 6 px : les tanks compacts publiés en prennent 2 |
| label_on_wire | 3 | un label barré est illisible | bbox estimée (7.2 px/char) ≈ approximative |
| label_overlap | 4 | idem | — |
| flow | 22 | piles à transistors haut→bas | passifs exemptés (tanks horizontaux légitimes) |
| rails / pair_sym / mirror_row | 10/8/6 | conventions fortes | — |

## Exercices

### E1 — LNA complet Shaeffer-Lee (JSSC97 Fig. 13, 18 composants, LVS 18/18)

Règles extraites (implémentées → commit) :
1. **Chaîne de signal** : les éléments série entre la source et une gate se
   déroulent horizontalement dans l'ordre du flux, à la hauteur de la gate.
2. **Dérivations de chaîne** : branche de polarisation (bias tee) VERS LE HAUT,
   shunt vers la masse VERS LE BAS, au droit de leur nœud.
3. **Source terminale** : la source V de la chaîne se pose en bas à gauche.
4. **L/R de conduction ≠ flottants** : une inductance touchant un drain/source
   (charge Ld, choke Lvdd, dégénérescence Ls) appartient à la PILE ; seuls les
   C (bloquants DC) et les L/R purement signal sont « flottants ».
5. **Pas de chaîne depuis un net de drain** (les ponts C des cross-couplés ne
   sont pas des chaînes) ; effets de capture différés à l'acceptation.

Poids questionnés :
- Pénalités ABSOLUES : un LNA de 18 composants paie chaque croisement au même
  prix qu'un RC de 4 — proposer une normalisation par n_composants
  (score = 100 − Σpénalités / (0.25·n_comp) par ex.). NON APPLIQUÉ (à valider).
- Budget E1 : crossings 54, excess_bend 43, too_close 30 → tout pointe l'étoile
  du nœud cascode (Lvdd+Ld+M4+gate M2). Règle candidate suivante : nœud de
  polarisation cascode = rail court horizontal au-dessus de la pile, M4 accolé.

### E1 (itération 2) — retour utilisateur : « le LNA est nul »

Règles ajoutées (implémentées) :
6. **Diode de polarisation accolée** : un MOS diode (D=G=net, S=0) suspendu à
   un net de pile se pose À CÔTÉ du nœud (col−0.55, niveau+0.55), jamais dans
   une colonne de conduction.
7. **Jonction sur l'axe de pile** : si ≥2 pins d'un net partagent le même x
   (éléments empilés), la jonction reste SUR cet axe, à mi-hauteur — fini
   l'étoile qui tire les fils de côté.
8. **Sortie vers l'extérieur** : un élément série menant à un port se place du
   côté extérieur du schéma (droite si le net est à droite du centre).

Reste identifié (candidat E1-iter3) : la masse de la diode accolée descend en
long rail qui croise la chaîne — règle « masse locale » : symbole de masse
juste sous la source de la diode, comme le petit trait du papier.

### E1 (itération 3) — « compte les angles droits » (retour utilisateur)

Comptage : figure publiée ≈ **4** angles droits (Vs→Rs, coude M4, liaison
diode, gate M2 — tout le reste est COLINÉAIRE par construction).
Ma copie : **38** → règles ci-dessous → **20** (croisements 9 → 1).

9. **Selfs verticales = symbole vertical natif** (`inductor_2`, pins
   traversants sur l'axe) — jamais une bobine horizontale tournée dont les
   pins en coin génèrent 2-4 coudes chacune.
10. **Axe de conduction unique** : MOS (canal), selfs, R/C tournées et
    jonctions partagent LE MÊME x dans une pile → fil vertical d'un trait.
11. **Jonction sur la ligne de chaîne** (axe Y) : ≥2 pins à même hauteur →
    le dot se pose SUR la ligne, au droit du pin dérivé.
12. **Alignement par PIN, pas par centre** : un élément de chaîne se cale
    pour que son pin tombe sur la ligne (les pins d'inductor_3 sont au bord
    bas, pas au centre).

Reste vers ~4 : boucle de la diode M4 + son rail de masse (règle « masse
locale » toujours candidate), T de Cm, montée Lb1.
Poids : excess_bend (1.4) a correctement guidé ces 4 règles — inchangé.

### E1 (itération 4) — masse locale

13. **Masse locale** : chaque symbole de masse se pose juste sous SON pin
    (comme le petit trait des figures publiées), jamais relié à une ligne de
    fond commune. Résultat : croisements 1 → 0 sur le LNA complet (le rail de
    M4 traversait la chaîne) ; coudes 20 → 22 (+2 assumés, le stub coûte un
    coude mais tue le croisement). ERC 0/0, LVS 18/18, 6/6 benchmarks LVS.

### Stratégies S1-S3 testées (état de l'art : Weave arXiv 2607.03835, EEschematic, MLCAD'22)

- **S1 hyperedges libavoid** : API non exportée par le bundle (embind minimal).
  Plan B implémenté : jonction au POINT MÉDIAN (optimum L1 exact du
  branchement unique) — neutre-positif, gardé (les règles d'axe priment).
- **S2 moteur ELK en couches** (`?engine=elk`, échelle de modes à la Weave) :
  implémenté, mesuré, PERD contre v2 sur les 7 circuits (OTA 20c vs 1c, E1
  59b vs 22b) — le layered générique ne connaît ni piles ni symétries
  analogiques. Conservé comme moteur de SECOURS pour netlists hors-motifs.
- **S3 compaction par alignement de pins** (`POST /compact`, intégrée en fin
  d'`?optimize` avec rollback) : chaque mouvement testé sous score
  géométrique rapide (beauty.py sans OpenCV). Jamais négatif ; gains E1
  22→19 coudes, Gilbert 32→28, biquad 27→23.

Leçon de poids : le score géométrique seul (sans rendu) suffit pour guider la
compaction — 20× plus rapide, à généraliser dans l'optimiseur (candidats
pré-filtrés sans rendu, rendu seulement pour les finalistes).

### Session « encore mieux » — leviers 1-4 (mesurés, gate LVS partout)

1. **Faisceau + score rapide** : tous les candidats évalués en géométrie pure
   (~200 ms), rendu OpenCV pour 3 finalistes → ~100 évaluations là où on en
   faisait 16, temps divisé par 4. Gilbert 28→14 coudes.
2. **Diode dessinée comme le papier** (fil direct gate→drain, l'étoile ne voit
   que le drain) + **ports montants dans l'axe** (flipV, label au-dessus) :
   E1 19→14 coudes, OTA 20→18.
3. **Symétrie exacte** dans pair_sym (centre de paire sur l'axe de la queue,
   ½ point hauteur + ½ point axe) — le faisceau l'optimise ; toutes les paires
   à 1.0 sauf Gilbert 0.5 (quad à 3 queues, cas à raffiner).
4. **Bus à tronc** (≥4 terminaux, large empan → 2 jonctions + tronc, comme la
   ligne vb des figures publiées).

Bilan benchmark (optimize=16) : LNA **2 coudes / 0 excès — MIEUX que le
papier (~4)** ; RC 4b ; VCO 0c/9b ; E1 0c/14b (38 au départ) ; OTA 0c/21b ;
biquad 2c/17b ; Gilbert 4c/14b (32 au départ). LVS 7/7, 21/21 tests.

### « Pourquoi des coudes 90° inutiles dans le Gilbert ? » — audit fil-par-fil

Réponse mesurée : 7 excès sur 3 fils seulement — M6→J_outm (traversée
totale), M4→M5 gates `lom` (740 px), M3→M6 gates `lop` (jog 28 px). Causes :
(a) ordre des colonnes du quad ≠ ordre canonique M3 M4 | M5 M6 ;
(b) **l'espace de recherche ne contenait pas la permutation** : seuls racines
et flips étaient explorables → ajout du mouvement « permutation de colonnes
sœurs sous un fanout » (P.childOrder) ;
(c) découverte critique en l'explorant : un placement légal (sans
chevauchement) peut faire BOUCLER ou ABORTER libavoid → **routage déplacé
dans un worker à timeout**, tué/relancé sur blocage ou `Aborted()` (le module
Emscripten est mort après un abort — piège documenté du fork), candidat
rejeté proprement ;
(d) règle « diagonales de quad » : net gate-gate même rangée à colonnes
éloignées → diagonale droite assumée (style des figures publiées), exclue du
routage. S'applique quand le faisceau ne choisit pas des gates adjacentes.

Restant assumé : le quad garde ~14-18 coudes selon la trajectoire du faisceau
(gates adjacentes VS X canonique) — la vraie sortie est le GABARIT de quad
(stratégie templates S4 du registre).

### Retour utilisateur : « paire RF pas au même niveau + ~12 coudes en trop »

14. **Paire différentielle = MÊME RANGÉE, toujours** (règle humaine imposée
    structurellement, plus un critère de score) ; queue recentrée sous le
    milieu de la paire. Cause du décalage : placement séquentiel des éléments
    partagés.
15. **Quad double-équilibré détecté** (patterns.quads : 2 paires dont les
    queues sont les drains d'une paire RF) → flips canoniques imposés (gates
    internes face à face), rangée du quad seulement (jamais la paire RF en
    colonne fractionnaire identique) ; membres exclus des flips de recherche.
16. **Tap d'alim ancré sur le PIN ABSOLU** (+30 px d'écart) : pour une forme
    TOURNÉE, l'ancien ancrage bbox posait le tap pin-sur-pin avec directions
    opposées → libavoid faisait un tour complet (les « rectangles fantômes »
    autour des charges du Gilbert).
17. Graine toujours finaliste : optimize ≥ v2 garanti (le score rapide et le
    score complet peuvent diverger).

Gilbert : paire alignée, quad canonique, boîtes fantômes éliminées ;
21 coudes (11 excès) restants — voie de sortie identifiée : gabarit de quad
avec lane lop dédiée (S4).

18. **Miroir vertical par défaut des paires diff** (retour utilisateur) :
    membre droit flippé colonne-avec-garde-de-niveau (rangée de la paire et
    en dessous uniquement) → gates vers l'extérieur, 2e entrée À DROITE.
    P.flipPairs devient un toggle d'inversion pour la recherche.

### « Pourquoi la source de courant monte puis redescend ? » — algorithme de cleaning

Diagnostic en 3 couches (chacune vérifiée) :
1. les fils de queue étaient géométriquement DROITS (0 waypoint, extrémités
   alignées) — l'escalier était fabriqué AU RENDU par le jettySize=auto du
   routeur implicite de drawio ;
2. libavoid renvoyait [] (« sans coude ») pour des chemins non alignés dans
   d'autres cas → le renderer improvisait aussi.

Nettoyeur implémenté (règles 19-21, dans routePage) :
19. **Équerre synthétique** : route vide + extrémités non alignées → coude
    unique explicite (axe de sortie du pin respecté) — plus jamais le
    routeur implicite.
20. **L canonique des jonctions** : tout fil pin→jonction dont le L est libre
    d'obstacles est posé en 2 segments (axe du pin, ligne de la jonction),
    jettySize=0 (le stub auto refaisait des marches).
21. **Collapse des micro-jogs** : motifs H-V-H / V-H-V à segment central
    ≤22 px aplatis vers le côté ancré/le plus long, test d'obstacle, point
    fixe en ≤6 itérations.

Effet suite (v2 brut) : biquad 15→7 coudes, VCO 10→6 (0 excès), Gilbert
15→12, OTA 24→18, E1 17→13. Queue du Gilbert = tracé humain exact.

22. **Interdiction absolue de superposition inter-nets** (retour utilisateur :
    « pas le droit de mettre 2 nœuds à potentiel différent l'un sur
    l'autre ») : passe `separateNets` en fin de routage — détection des
    segments colinéaires (<5 px d'écart de lane, >10 px de recouvrement)
    entre nets DIFFÉRENTS (union-find local jonctions/pins), réparation par
    décalage de lane du segment intérieur mobile, sinon dog-leg sur le
    recouvrement ; redémarrage du scan après chaque réparation, plafond 30.
    Les deux issues autorisées : lanes à y différents (implémenté) ou
    croisement diagonal assumé (les diagonales edgeStyle=none sont exclues
    de la détection).

23. **Les règles humaines sont des INVARIANTS, pas des dimensions de
    recherche** (retour utilisateur : « tu as réparé un point et cassé le
    travail d'avant »). L'optimiseur avait le droit de basculer le miroir des
    paires (toggle flipPairs) et de permuter les colonnes des structures →
    il le faisait dès que le score y gagnait. Supprimé : plus de move
    flipPairs ; les permutations de fanout excluent tout net dont un enfant
    appartient à une structure reconnue (paire, quad, miroir, queue).
    L'optimiseur ne règle plus que l'espacement, l'ordre des piles
    indépendantes et les flips de passifs. Gilbert : 8 coudes AVEC toutes
    les règles intactes.

24. **Liaison diode = petit cadre EXTÉRIEUR au corps** (waypoints explicites
    gate→coin→drain) — le renderer dessinait sinon une diagonale à travers
    le transistor. Idiome délibéré des figures publiées : exempté du
    comptage de coudes (comme les diagonales de cross-couplage).

### Relance des règles sur les 5 références (état courant, optimize=12)
OTA 1c/11b · biquad 2c/7b · LNA complet 0c/9b · VCO 0c/8b · Gilbert 4c/8b —
LVS 5/5, toutes les règles utilisateur intactes (invariants).
