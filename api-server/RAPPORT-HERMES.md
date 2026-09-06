# RAPPORT-HERMES — mission « ramener les erreurs checker au plus bas sans casser le LVS »

Branche `avo/lvs-20260903`, répertoire `api-server/`. Orchestration : parent Claude (plan, mesures,
intégration, commits), sous-agents délégués (bisect ×4, correctifs ×4, revues ×4). Date : 2026-09-06.

## Résultat

| étape | commit | LVS | erreurs checker | beauty moyen | circuits à 0 erreur |
|-------|--------|-----|-----------------|--------------|---------------------|
| départ | f8c4afc | 43/43 | **34** | 66.6 | 30/43 |
| C1 score rapide réparé | 55d9ed0 | 43/43 | 16 | **73.0** | 35/43 |
| C3 port de rail suspendu | 377549d | 43/43 | 15 | 72.9 | 36/43 |
| C4 polishJogs | 0dd425b | 43/43 | **11** | 72.5 | 36/43 |

Mesure : `benchmark/run30.py --optimize 8` sur les 43 circuits, serveur `node server.js --port 8775`,
juge `tools/check.py` inchangé (aucun fichier de `tools/`, `lib/check.js`, `benchmark/`, `test/` touché ;
connectivité — source/target/exit/entry/ids/refdes — intacte, vérifié par `git diff` et par les revues).
`npm test` : 105 pass / 9 fail avant et après chaque commit, les 9 échecs étant les fixtures RF absentes
(identiques nom pour nom à ceux de f8c4afc). Objectif « sans baisser le beauty moyen » : 66.6 → 72.5.

## Ce que le bisect a établi

1. **Les commits d002649 / 34dfe2c / 0bff66c ne descendent PAS de a855c74** (branche RF parallèle,
   base commune c9c73a7, sans les règles 53-59). Les comparer à a855c74 n'a aucun sens ; la seule chaîne
   linéaire est a855c74 → eab1d7b (fusion) → b8ba7c4 → a45f11a → f8c4afc. Mesuré à juge fixe :
   a855c74 = 17 erreurs ; eab1d7b = b8ba7c4 = a45f11a = f8c4afc = 34 erreurs sur les sondes.
   **Toute la régression est dans la fusion eab1d7b.**
2. **Une seule cause explique les +17** : dans la fusion, `tools/beauty.py` (venu de la branche RF)
   ne renvoie la clé `score` que si `missing_weight == 0`. L'appel « rapide » (XML seul, sans PNG) ne
   fournit que `score_partial`/`score_raw`. `lib/compact.js::fastScore()` lisait `.score` → `undefined` :
   - le faisceau de `optimize.js` triait des NaN (`history` : `score: null` à g0/g1/g2, `params: {}`),
     donc renvoyait le placement brut, jamais amélioré ;
   - `compactPage` (`if (s2 > score)`) n'appliquait plus aucun mouvement.
   Le routage (through, wrap-around, 22, comp-overlap) n'était pas fautif : **le générateur ne cherchait
   plus**. Preuve : sur gilbert-mixer a855c74 trouvait `flip:{R2:true}` (1 erreur) ; f8c4afc rendait
   `params:{}` (6 erreurs) ; après C1, f8c4afc+C1 retrouve `flip:{R2:true}`.
3. Le score beauty 0 de bandgap/folded-cascode et le 7 de cherry avaient la même cause (générateur, pas
   notation) : après C1, bandgap 0 → 72.2, folded 0 → 18.9, cherry 7.1 → 31.0.

## Commits (un par cause, message = tableau avant/après)

### C1 — 55d9ed0 « score rapide muet depuis la fusion » (règle 61) — 34 → 16, beauty 66.6 → 73.0
`lib/compact.js` fastScore : `score_raw` → `score` → `score_partial`, sinon lève ; `lib/optimize.js` :
candidat rejeté (`reason:'score'`) si le score n'est pas fini ; `lib/beauty.js` : `score_partial`
exposé comme `score` s'il manque (clampé [0,100] pour l'utilisateur, `score_raw` reste pour rankValue).
gilbert 6→1, bandgap 3→0, mixer-passive-ring 3→0, ota-symmetrical 3→0, vco-lc-tail-filter 4→2,
vco-lc-pmos 2→1, pierce 1→0, inverter-amp 1→0 ; strongarm 5→6. Revue : accept (une suggestion intégrée).

### C3 — 377549d « port de rail de quad suspendu » (règle 62) — 16 → 15
Défaut révélé par C1 : les deux rails d'un quad sont à 20 px ; le port d'interface (24×24, pin en haut)
posé SOUS sa lane avait le rail inférieur À TRAVERS son corps (through gilbert PN6/OUTM, masqué à
f8c4afc par une oblique de compaction). `lib/place2.js` : si une lane étrangère passe dans la bande
[lane, lane+32], port suspendu au-dessus (flipV, étiquette en haut), mécanisme déjà utilisé pour le
port upFacing. gilbert 1→0 (beauty 66.9→60.4, acceptée : un fil à travers un corps est une lecture
électrique fausse). Revue : accept.

### C4 — 0dd425b « polishJogs glisse aussi le point lointain » (règle 63) — 15 → 11
`lib/route.js::polishJogs` aplatit un coude H-V-H court mais laissait p3 sur son ancienne lane :
p2→p3 devenait une oblique de 14-16 px (strongarm M7→M9 314×14, M7→M8 79×16 / 132×16), invisible à
l'œil, refusée par la règle « diagonal ». Le point lointain glisse aussi, seulement si le segment
au-delà est vertical et si le petit segment créé ne traverse aucun corps ; symétrique V-H-V.
strongarm 6→2 (ses 22/22-contact disparaissent aussi : l'optimiseur, classant d'abord par erreurs,
retient un autre placement, beauty 45.5→16.4) ; inverter-amp, pa-class-a, rgc-tia gagnent 2-6 points
de beauty. Revue : accept_with_changes (garde `blocked` sur le nouveau segment + cas `yT == far.y`),
les deux intégrées avant commit.

## Correctifs mesurés et NON commités

- **C2 compaction réversible** (`/tmp/hermes-bisect/c2-compaction-reversible-NON-COMMITE.patch`,
  lib/compact.js + export rootEl) : l'essai de compaction ne remettait que le sommet, pas les fils
  re-routés. Correct sur le principe (revue : accept_with_changes), mais mesuré sur 43 : +1 à +2 erreurs
  (inverter-amp 30, vco-lc-pmos pin-clearance) et gilbert beauty −20, parce que la compaction
  « cassée » masquait ces défauts en produisant, par accident, une géométrie que le juge acceptait.
  À reprendre quand les deux défauts sous-jacents (dot manquant au té gate M2 / fil à 4 px du pin M2)
  seront traités dans le routeur.
- **C3-bis du sous-agent (polishJogs)** : rejeté à la revue par le parent — la garde ajoutée
  `|p1.x−p2.x| ≥ 0.6` contredit `isV(p1,p2)` et désactivait silencieusement tout l'aplatissement ;
  la « garde finale » insérait des coins sans tester le segment créé. Remplacé par C4.
- **C5 cherry-hooper** : diagnostic seulement (R2, feedback de l'étage 2, placée au-dessus de la charge
  R4 alors que son net outm est au pin bas de R4 ; la pose des R de feedback précède la position finale
  de M3). Pas de correctif net sans régression en temps borné → laissé tel quel.

## Ce qui reste (11 erreurs, 0dd425b)

| circuit | err | règles | remarque |
|---------|-----|--------|----------|
| strongarm-latch | 2 | diagonal ×2 | X volontaires (edgeStyle=none, règle 34) |
| vco-lc | 2 | diagonal ×2 | X volontaires |
| vco-lc-tail-filter | 2 | diagonal ×2 | X volontaires |
| vco-lc-pmos | 1 | diagonal | X volontaire |
| cherry-hooper | 2 | wrap-around, pin-clearance | R de feedback étage 2 au-dessus de la charge (voir C5) |
| beta-multiplier | 1 | 30 | té coincé à 4 px d'un dot (déjà noté règle 59) |
| wilson-mirror | 1 | 28 | side-diode instable (déjà noté règle 59) |

**7 des 11 erreurs sont les diagonales des X cross-couplés que le générateur trace volontairement**
(règle 34 : « le X des figures publiées est LA solution ») et que `check_orthogonal` (règle utilisateur
du 2026-08-31 : « aucune diagonale, nulle part ») compte en erreur. C'est une contradiction entre deux
règles du registre, pas un défaut de code ; la mission interdisant de toucher au juge, elle est laissée
à l'arbitrage de l'utilisateur (soit exempter `edgeStyle=none` dans le checker, soit remplacer le X par
deux tracés orthogonaux — ce que la règle 34 dit avoir mesuré « irréparable »). Hors ces 7, il reste
**4 erreurs sur 43 circuits** (contre 17 à a855c74 et 34 à f8c4afc).

## Tableau par circuit (f8c4afc → 0dd425b), circuits ayant eu au moins une erreur

| circuit | err avant | règles avant | beauty avant | err après | règles après | beauty après |
|---|---|---|---|---|---|---|
| bandgap-core | 3 | comp-overlap, through×2 | 0.0 | 0 | - | 72.2 |
| beta-multiplier | 1 | 30 | 78.4 | 1 | 30 | 78.4 |
| cherry-hooper | 2 | wrap-around, 22 | 7.1 | 2 | wrap-around, pin-clearance | 31.0 |
| gilbert-mixer | 6 | wrap-around, comp-overlap, through×2, diagonal×2 | 40.9 | 0 | - | 60.4 |
| inverter-amp | 1 | 30 | 71.5 | 0 | - | 76.8 |
| mixer-passive-ring | 3 | 22, 22-contact×2 | 24.5 | 0 | - | 63.5 |
| ota-symmetrical | 3 | through, pin-clearance, 30 | 32.7 | 0 | - | 42.8 |
| pierce-xtal | 1 | wrap-around | 59.1 | 0 | - | 51.7 |
| strongarm-latch | 5 | 22, 22-contact×2, diagonal×2 | 32.6 | 2 | diagonal×2 | 16.4 |
| vco-lc | 2 | diagonal×2 | 85.7 | 2 | diagonal×2 | 91.0 |
| vco-lc-pmos | 2 | wrap-around, 22 | 76.2 | 1 | diagonal | 80.3 |
| vco-lc-tail-filter | 4 | wrap-around×2, diagonal×2 | 66.4 | 2 | diagonal×2 | 79.6 |
| wilson-mirror | 1 | 28 | 71.7 | 1 | 28 | 76.2 |

Les 30 autres circuits restent à 0 erreur ; leur beauty ne baisse nulle part (folded-cascode 0→18.9,
colpitts 72.5→86.3, lna-cs-cascode 59.8→74.4, delay-cell 44.2→57.7, pa-class-a 60.4→69.0…).
Résultats bruts : `/tmp/hermes-bisect/results/{f8c4afc,55d9ed0,377549d,0dd425b}.json` ;
XML/PNG des runs : `/tmp/bench-base`, `/tmp/bench-c1`, `/tmp/bench-c3only-full`, `/tmp/bench-c4b`.

## Leçons (ajoutées à `training/RULES.md`, règles 61-63)

- Un juge qui change la FORME de sa réponse (clé `score` devenue conditionnelle) casse silencieusement
  ses clients ; tout score consommé pour comparer doit être vérifié `Number.isFinite()`.
- Une « régression de routage » peut n'être qu'un optimiseur aveugle : avant de bisecter le routeur,
  vérifier que `history` contient des nombres et que `params` n'est pas vide.
- Réparer l'optimiseur révèle les défauts que le hasard masquait (through PN6, obliques de 14 px) ;
  c'est attendu, et chacun a ensuite une cause propre.
- Outillage utile laissé en place : `/tmp/hermes-bisect/bench-at.sh <commit> <port> <outdir>` (benchmark
  d'un commit à juge fixe, worktree sous `~/ClaudeCode/avo-work/bisect-wt/` — pas `/tmp`, chromium snap
  n'y accède pas), `/tmp/hermes-bisect/trace.mjs <circuit> '<params>' [nocompact] [out.xml]` (segments
  obliques après chaque étape place2/route/normalize/compact), `/tmp/hermes-bisect/gen.py`.
  Le serveur a besoin de `BEAUTY_PYTHON=/home/courcirc8/ClaudeCode/schematic/dgx-osr/.venv/bin/python`
  (cv2) sinon `/beauty` renvoie 500 et tout le benchmark échoue.
