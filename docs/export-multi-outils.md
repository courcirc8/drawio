# Export multi-outils et schéma neutre (version courte, 11 oct. 2026)

Cap validé par Eric : faire de drawio une skill de création de schémas. Netlist SPICE → **schéma neutre**
(`schema-neutre/1`, lib/neutral.js) → un traducteur par outil : draw.io (existant), xschem (1, kit IHP), KiCad (2),
Qucs-S (3), LTspice `.asc` / SVG (4), Cadence SKILL (en dernier, non testable sans licence).

## Principes

- Le placement et le routage se font **dans la géométrie de la cible** : boîtes, broches et grille lues dans les
  bibliothèques de l'outil (xschem IHP `.sym`, KiCad `.kicad_sym`, composants Qucs-S). Le neutre est en unités de la
  cible ; le traducteur ne fait que nommer les symboles et écrire.
- Contrôle à chaque étape : le neutre se vérifie seul (sa géométrie redonne la netlist, LVS) ; après traduction,
  l'outil régénère la netlist (`xschem -n`, `kicad-cli sch export netlist`, netlist Qucs-S) → LVS. Jamais de fichier
  faux livré.
- Les règles d'Eric (zéro coude évitable, X à 45°, rail unique, ports alignés) sont des contrôles de l'export dans
  CHAQUE géométrie cible, pas seulement draw.io.
- Conventions : y vers le bas ; miroir appliqué avant la rotation (degrés, sens horaire) ; test des 8 combinaisons
  miroir × rotation pour chaque outil.

## Ce que l'on reprend (étude de l'existant, `references/ANALYSE-EXPORT.md`, hors Git)

| Dépôt | Licence | Repris |
|---|---|---|
| spice2sch | BSD-3 | boucle de contrôle xschem re-netliste → LVS ; lecture des broches `B 5` des `.sym` du PDK ; écriture `.sch` |
| skidl | MIT | séparation « décider » (indépendant de l'outil) / « émettre » (backend par outil) |
| kicad-sch-api | MIT | écriture fidèle du `.kicad_sch`, inversion Y des symboles, snap 1,27 mm, netlist par kicad-cli |
| virtuoso-cli, SKILL | MIT | API SKILL utilisable (schCreateInst, schCreateWire, schCreatePin), pièges IC23.1 |
| xschem | GPL-2 | idées seulement (format `.sch`, broches couche 5) |
| kicad-skip | LGPL-2.1 | idées seulement (calcul de broche KiCad) |

Placeurs génériques (forces, ELK, grille) non repris : les gabarits et règles d'Eric sont meilleurs. Tout extrait
copié porte un commentaire de provenance et une ligne dans `THIRD_PARTY.md` (dépôt, fichier, commit, licence).

## Étapes

1. Neutre extrait de la page draw.io + LVS sur le neutre (sans changer le placement).
2. Symboles xschem IHP → moteur paramétré par la géométrie cible → traducteur `.sch` → `xschem -n` + LVS (banc de la
   session Simulation, via l'orchestrateur).
3. KiCad ; 4. Qucs-S, LTspice, SKILL ; 5. skill « schema-depuis-netlist » + PROMOTION.md.
