# PLAN-HERMES — orchestration de la mission (parent Claude, sous-agents delegues)

Date : 2026-09-06. Branche : `avo/lvs-20260903` (HEAD f8c4afc). Repertoire : `api-server/`.

## 0. Etat mesure au depart (baseline, juge = tools/check.py de f8c4afc)

Mesure par le parent : `DRAWIO_BASE=http://127.0.0.1:8775 python3 benchmark/run30.py /tmp/bench-base --optimize 8`
(serveur : `BEAUTY_PYTHON=<venv cv2> node server.js --port 8775`). Voir section 6 pour le tableau.

Attendu (MISSION) : LVS 43/43, 34 erreurs checker, beauty moy 66.6.

## 1. Infrastructure de mesure (parent)

- Serveur de travail : port 8775, worktree `drawio-avo2` (cette branche).
  `BEAUTY_PYTHON=/home/courcirc8/ClaudeCode/schematic/dgx-osr/.venv/bin/python` obligatoire
  (beauty.py importe cv2 ; le python3 systeme ne l'a pas -> 500 sur tout le benchmark).
- Bisect : `/tmp/hermes-bisect/bench-at.sh <commit> <port> <outdir> [--only ..] [--optimize N]`
  cree un worktree detache `~/ClaudeCode/avo-work/bisect-wt/<sha>` (PAS /tmp : chromium snap n'y a pas
  acces -> ERR_FILE_NOT_FOUND sur export3.html), lance le serveur de CE commit sur `<port>`, puis
  run30.py **du depot de travail** (juge FIXE = check.py f8c4afc) contre ce port. Sortie :
  `<outdir>/run.log`, `<outdir>/results.json`, `<outdir>/<circuit>.xml`.
- Ports reserves : 8775 parent ; 8781-8784 sous-agents bisect ; 8785-8788 sous-agents correctifs.
- Iteration rapide : `--only a,b --optimize 2` (~8 s/circuit). Complet : `--optimize 8` (~6 min).
- Verification LVS : colonne `lvs=True` x43 dans run.log.

## 2. Perimetre interdit (regles dures, rappelees a chaque sous-agent)

Ne jamais modifier : `tools/check.py`, `tools/beauty.py`, `tools/test-check.py`, `lib/check.js`,
`benchmark/`, `test/`. Ne jamais toucher a la connectivite (source/target/exitX/entryX/ids/refdes)
dans route/compact/rewire. Le parent verifie par `git diff --stat` avant chaque commit.

## 3. Sous-taches de DIAGNOSTIC (delegate_task, parallele, 1 famille de regles par agent)

Commits candidats (first-parent a855c74..f8c4afc) : 8d1e7fb 67c6d81 0bff66c 5b482f9 d002649 cd428bc
17c4335 f199ae8 34dfe2c eab1d7b b8ba7c4 a45f11a 6bc6dd3 f8c4afc.
Seuls 3 touchent `lib/` de facon significative : d002649 (place3, stencils, components, model),
34dfe2c (route.js +222, rewire.js, preplace, optimize.js), a45f11a (invariant, compact, route, rewire),
f8c4afc (place2 +89). Bisect cible : a855c74 -> d002649 -> 34dfe2c -> a45f11a -> f8c4afc.

| id | famille de regles | circuits sondes | port |
|----|-------------------|-----------------|------|
| D1 | through + wrap-around | gilbert-mixer, strongarm-latch, vco-lc-tail-filter, cherry-hooper, vco-lc | 8781 |
| D2 | 22 + 22-contact + pin-clearance | gilbert-mixer, strongarm-latch, ota-symmetrical, mixer-passive-ring, bandgap-core | 8782 |
| D3 | diagonal + comp-overlap + 30 + 28 | gilbert-mixer, bandgap-core, vco-lc-pmos, beta-multiplier, wilson-mirror, pierce-xtal, inverter-amp | 8783 |
| D4 | beauty 0 (bandgap-core, folded-cascode) + cherry 7 : quel commit fait chuter le score ? | bandgap-core, folded-cascode, cherry-hooper | 8784 |

Interface de sortie de chaque agent : JSON `{rule, first_bad_commit, evidence: [{commit, circuit, errors}],
root_cause_hypothesis, files_lines}` + texte libre. Le parent croise les 4 resultats.

## 4. Sous-taches de CORRECTION (une par cause, sequentielles ou parallelisees si fichiers disjoints)

Chaque agent correctif recoit : la cause, les fichiers/lignes, la commande de mesure rapide
(`--only <circuits fautifs> --optimize 2` sur SON port), l'interdit du 2, et doit :
1. modifier `lib/` seulement ; 2. ajouter la regle N (60+) dans `training/RULES.md` ;
3. `npm test` — 9 echecs pre-existants (fixtures RF absentes) toleres, tout NOUVEL echec bloquant ;
4. rendre un diff (`git diff`) + tableau avant/apres sur ses circuits sondes. NE PAS commiter.

## 5. REVUE puis COMMIT (parent)

Pour chaque correctif : un agent REVIEWER independant recoit le diff + le tableau et repond
`{verdict: accept|reject, risks, connectivity_touched: bool, forbidden_files_touched: bool}`.
Si accept : le parent lance le benchmark COMPLET (`--optimize 8`, port 8775), verifie
LVS 43/43, erreurs <= precedent, beauty moyen >= precedent, puis commit atomique avec le tableau
avant/apres dans le message. Sinon : retour a l'agent correctif ou abandon.

## 6. Tableau de bord (rempli au fil de l'eau)

| etape | commit | LVS | erreurs | beauty moy | regles |
|-------|--------|-----|---------|------------|--------|
| baseline | f8c4afc | 43/43 | 34 | 66.6 | diagonal 8, wrap-around 6, through 5, 22 x4, 22-contact x4, 30 x3, comp-overlap 2, pin-clearance 1, 28 x1 |
| C1 fastScore | 55d9ed0 | 43/43 | 16 | 73.0 | diagonal 9, 22-contact 2, 22/30/28/wrap-around/pin-clearance 1 |
| C3 port rail quad | 377549d | 43/43 | 15 | 72.9 | diagonal 8, 22-contact 2, 22/30/28/wrap-around/pin-clearance 1 |
| C4 polishJogs | 0dd425b | 43/43 | 11 | 72.5 | diagonal 7 (X volontaires), 30/28/wrap-around/pin-clearance 1 |
| C2 compaction reversible (mesure, NON commite) | — | 43/43 | 12 | 72.5 | revele inverter-amp 30 + vco-lc-pmos pin-clearance ; patch garde dans /tmp/hermes-bisect |

Diagnostic (section 3) : les commits d002649/34dfe2c/0bff66c ne descendent pas de a855c74 (branche RF
parallele) ; la chaine lineaire est a855c74 -> eab1d7b -> b8ba7c4 -> a45f11a -> f8c4afc et toute la
regression est dans la fusion eab1d7b (fastScore undefined). Detail dans RAPPORT-HERMES.md.

## 7. Livrable final

`RAPPORT-HERMES.md` : erreurs avant/apres par circuit, commits, causes trouvees, ce qui reste.
