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

## État (11 oct. 2026)

- **xschem / IHP SG13G2** (`lib/export-xschem.js`, `tools/xschem-check.mjs`, PR #39) : banque, 40 circuits R C L V I MOS →
  36 exportés, 36/36 LVS justes par le netlister de xschem, refus propres sinon.
- **KiCad 10** (`lib/export-kicad.js`, `tools/kicad-check.mjs`) : symboles Device R/C/L, Simulation_SPICE VDC/IDC/
  NMOS_Substrate/PMOS_Substrate, power GND/VDD lus dans les `.kicad_sym` installés (Flatpak) ; 10 unités = 1,27 mm ;
  fils coupés à chaque point de connexion (KiCad relie les extrémités), jonctions explicites ; netlist par
  `kicad-cli sch export netlist` → LVS. Banque : 38 exportés, 36 LVS justes, le reste refusé. Particularité : la broche de
  substrat KiCad est sur la ligne de la source ; un fil d'un autre net qui la traverse est accepté (KiCad ne relie qu'une
  extrémité, vérifié) avec un avertissement ; un fil qui s'y termine ou y fait un coude → refus.
- **Qucs-S 26** (`lib/export-qucs.js`, `tools/qucs-check.mjs`) : ports lus dans les sources de Qucs-S (positions seules,
  provenance fichier:ligne dans l'en-tête) ; miroir puis rotations ; fils coupés aux points de connexion ; masse GND, rails
  et ports par étiquettes de fil ; netlist par `qucs-s -n --ngspice` (conteneur sim-gui + Xvfb, borné dans le temps) → LVS.
  Banque : 33/40 livrés, 7 refusés (sources non continues — pulse — non traduites, noms de nets internes). L'impression
  sans écran de Qucs-S sort sans aucun texte (polices) : pas de rendus pour Eric tant que ce n'est pas réglé.
- **LTspice** (`lib/export-ltspice.js`, `tools/ltspice-check.mjs`) : AVEC de vrais fils (l'ancien `lib/export-asc.js`
  posait une étiquette par broche — une connexion par nom) ; broches de `data/ltspice-symbols.json` (Weave, MIT),
  16 unités LTspice = 10 ; masse et rails par drapeaux ; contrôle par `tools/asc2spice.mjs` (lecteur indépendant, règles
  de LTspice ; LTspice lui-même n'est pas installé). Banque : 33/40 livrés, 7 refusés.
- Livraison : `deliverXschem` / `deliverKicad` / `deliverQucs` / `deliverLtspice` n'écrivent le fichier final que si la
  netlist relue par l'outil (ou le lecteur) redonne le deck ; sinon refus, aucun fichier.
- Géométrie cible partagée : `lib/target-geometry.js` (pochoirs à la géométrie de l'outil pendant le placement, recherche
  de l'orientation qui pose chaque broche).
- Rendus pour Eric : `/drawio/review?batch=export-xschem`, `batch=export-kicad` (`tools/xschem-renders.mjs --tool`).

## Étapes

1. Neutre extrait de la page draw.io + LVS sur le neutre (sans changer le placement).
2. Symboles xschem IHP → moteur paramétré par la géométrie cible → traducteur `.sch` → `xschem -n` + LVS (banc de la
   session Simulation, via l'orchestrateur).
3. KiCad ; 4. Qucs-S, LTspice, SKILL ; 5. skill « schema-depuis-netlist » + PROMOTION.md.
