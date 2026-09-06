# Mission (orchestration Hermes : parent Claude, sous-agents Qwen3-Coder-Next)

## Contexte
Generateur netlist SPICE -> schema drawio (`lib/place2.js` placement, `lib/route.js` routage,
`lib/patterns.js` structures, `lib/invariant.js` invariant LVS, `server.js` API :8770).
Benchmark de reference : `benchmark/netlists30/*.cir` (43 circuits), lance par
`benchmark/run30.py <outdir> [--optimize N] [--only a,b]` contre un serveur
(`DRAWIO_BASE=http://127.0.0.1:PORT`). Juge independant : `tools/check.py <xml> --netlist <cir> --json`
(erreurs DRC schematique) ; score esthetique `tools/beauty.py`. Regles apprises : `training/RULES.md` (59).

Etat mesure sur cette branche (commit f8c4afc, 2026-09-03) :
- LVS 43/43 (l'invariant tient), mais **34 erreurs checker** et beauty moyenne 66.6 ;
- circuits fautifs : gilbert-mixer 6, strongarm-latch 5, vco-lc-tail-filter 4, bandgap-core 3,
  mixer-passive-ring 3, ota-symmetrical 3, cherry-hooper 2, vco-lc 2, vco-lc-pmos 2, beta-multiplier 1,
  inverter-amp 1, pierce-xtal 1, wilson-mirror 1 ;
- regles : wrap-around 6, through 5, 22 x4, 22-contact x4, diagonal 8, 30 x3, comp-overlap 2, pin-clearance 1, 28 x1 ;
- beauty 0 : bandgap-core, folded-cascode ; cherry-hooper 7.
- FAIT ETABLI : les sorties de l'ancien generateur (commit a855c74 de feature/api-server), jugees par le
  MEME check.py, ne font que 17 erreurs (13 = nouvelle regle `diagonal`). La fusion `merge-api-server`
  (12 commits : place3 RF, « routage droit, repli de net des ports » 34dfe2c, etc.) a donc REGRESSE le
  generateur de +17 erreurs (through, wrap-around, 22, 22-contact, comp-overlap, 30).

## Objectif
Ramener les erreurs checker au plus bas SANS JAMAIS casser le LVS (43/43) ni le score beauty moyen,
en commits atomiques sur cette branche (`avo/lvs-20260903`), chacun mesure sur les 43 circuits.

## Plan suggere
1. DIAGNOSTIC (delegable en parallele) : bisecter la regression entre a855c74 et f8c4afc — quels commits
   introduisent through / wrap-around / 22 / comp-overlap ? (`git log a855c74..f8c4afc --oneline`,
   generer les circuits fautifs a chaque commit candidat avec `--only`, juger avec check.py).
2. CORRECTION : pour chaque cause, corriger dans lib/ (jamais dans les juges), ajouter la regle 60+ a
   `training/RULES.md`, verifier `npm test` (9 tests lisent des fixtures RF absentes de cette machine et
   echouent DEJA : tolere ; tout NOUVEL echec est bloquant) puis benchmark complet.
3. REVUE : chaque correctif est relu par un sous-agent independant (diff + tableau avant/apres) avant commit.

## Regles dures
- Interdit de modifier : tools/check.py, tools/beauty.py, tools/test-check.py, lib/check.js, benchmark/, test/.
- Interdit de toucher a la connectivite (source/target/exitX/entryX, ids, refdes) dans route/compact/rewire.
- Un commit = une cause, message explicite, benchmark avant/apres dans le message.
- Serveur pour le benchmark : `node server.js --port 8775` (PAS :8770, qui sert le depot principal),
  puis `DRAWIO_BASE=http://127.0.0.1:8775 python3 benchmark/run30.py /tmp/bench-xxx --optimize 8`.
  Le benchmark complet dure ~7 min ; `--only` + `--optimize 2` pour iterer vite.
- Rapport final : erreurs avant/apres par circuit, commits, causes trouvees, ce qui reste.
