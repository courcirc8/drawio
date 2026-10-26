# Dessin hiérarchique (`?hier=1`)

Décision de l'Orchestrateur (25.10.2026, pour analog-design) : une netlist hiérarchique (TIA Butterworth 3 :
ota1..ota3 en `.subckt`, banques commutées, ~260 composants aplatis) se dessine en **plusieurs pages** : une par
sous-circuit, une par banque ou chaîne regroupée, et une page `top` de blocs.

## API

`POST /documents/:id/netlist/import?hier=1[&per=instance][&symbols=…][&force=1]`, corps `{spice}` ou texte.

`symbols` (D2) : `ota:ota,demarrage:box` ou un objet JSON (aussi `{"symbols": …}` dans le corps), symbole de chaque
`.subckt` sur les pages qui l'instancient : `ota` (triangle), `ota_fd` (triangle, `outp`/`outn`), `box`.

Réponse 201 (422 si un LVS échoue, sauf `force=1`) :

```json
{ "engine": "hier", "per": "definition",
  "pages": [{ "name": "top", "kind": "top", "engine": "blocks", "lvs": true, "geo": true },
            { "name": "ota1", "kind": "subckt", "engine": "manuel", "lvs": true }, …],
  "map": { "XA1.XM5": { "page": "ota1", "cell": "XM5" }, "XA1": { "page": "top", "cell": "XA1" },
           "XSWF11": { "page": "bank_o1n_inp", "cell": "XSWF11" } },
  "lvs": { "pages": { "top": true, "ota1": true, … }, "global": true, "warnings": [] },
  "banks": [{ "name": "bank_o1n_inp", "kind": "bank", "pins": ["o1n", "inp", "vcmref", "0"], "parts": [] }] }
```

- `map` : toute référence aplatie (comme le parseur l'écrit, `XA1.XM5`) → page et identifiant de cellule (la
  référence locale). Les surimpressions par transistor (analog-design) passent par là.
- `GET /documents/:id/export?format=png&page=<nom>` rend une page ; `format=xml` rend le `.drawio` multipage.
- `GET /documents/:id/hier/pages[?scale=1]` (D5) : `{ pages: [{ name, id, svg, mapping, cells }], map }`. Chaque page
  en SVG ; `cells` = boîte de chaque composant et bloc en unités du SVG (`{x, y, w, h, ref, block?, page?}`) ; `map`
  = la `map` du dernier import `?hier=1`, chaque référence aplatie avec sa page et sa boîte. C'est ce qu'il faut à
  `calques.py` pour poser les valeurs page par page. Chaque bloc porte une zone cliquable `<a xlink:href="<page>.svg">`.

## Pages

| Page | Contenu | Moteur |
|---|---|---|
| `<subckt>` (défaut) ou `<chemin d'instance>` (`per=instance`) | le corps du `.subckt`, noms locaux, broches en E/S | `auto` (manuel d'abord) ; blocs si le corps contient des `X` |
| `bank_<A>_<B>` | banque commutée du top | `auto` → échelle manuelle (sources de grille comprises) |
| `chain_<préfixe>` | chaîne série de résistances unitaires (`XRF1u0..u22`) | serpentin de 6 par rangée |
| `top` | instances `X` et groupes en blocs (rectangle, broches nommées), le reste à plat | placeur de blocs |

## Regroupement automatique (sans réécrire la netlist)

- **Banque** : groupes de composants reliés seulement par des nets privés, touchant le même ensemble de nets
  « moyeux » (rails, nets à ≥ 5 composants, broches de blocs) ; ≥ 3 groupes de même signature = une banque, plus le
  composant direct entre deux de ses moyeux du même type qu'un composant de la banque (la capacité fixe `XF10`).
- **Chaîne** : composants R/C/L à deux bornes bout à bout par des nets utilisés par exactement ces deux-là (ni rail
  ni broche de bloc), ≥ 2 éléments.

## Page top

- Étages = instances `X`, ordonnés par le flux du signal (largeur d'abord depuis l'étage alimenté par une source ou
  un net `in*`). Côtés des broches par leur nom dans le `.subckt` : `in*` à gauche, `out*`/`o*` à droite,
  alimentation en haut, masse et le reste en bas.
- Autour de chaque étage : **contre-réaction** au-dessus (sortie → entrée du même étage ou d'un étage antérieur),
  **série** dans l'intervalle suivant, charges après le dernier étage, entrée avant le premier, sources à gauche.
- v1 : connexions par **étiquettes** (chaque broche a son fil court et son nom) ; fils directs entre broches voisines
  = amélioration possible.
- **Rails** (D1) : `power`, `ground`, `power_<dom>`, `ground_<dom>` (convention d'analog-design) sont des
  alimentations et des masses comme `vdd`/`vss` : broche en haut ou en bas, symbole de rail sur les pages. Le LVS
  global lie une broche au net de la page sur la même borne quand la page l'a renommé (`ground_ana` dessiné en masse).
  Un domaine dessiné en masse garde son nom écrit sous le symbole (`ground_ana`), le net extrait reste `0`. Les noms
  de signal évidents ne sont pas des rails : `power_down`, `power_good`, `power_on`, `power_en`, `ground_sense`…
  (suffixe `down`, `good`, `on`, `off`, `en`, `ok`, `sense`, `fail`, `rst`, `sel`, `det`, `ready`, `ctrl`… après `_`).
- **Triangle d'ampli** (D2) : un `.subckt` défini qui est un ampli devient un triangle pointé à droite (`apiSymbol`) :
  `+`/`−` à gauche (polarité par le nom `inp`/`inn`, `vip`/`vin`… ; sinon l'ordre des broches et aucun signe), sortie à la pointe (`outp`/`outn`
  sur les côtés près de la pointe), alimentations sur le côté haut, masses et autres broches (`ibias`, `vcmref`) sur
  le côté bas puis haut, au plus 3 par côté. Choix explicite d'abord (`symbols`, commentaire `*.symbol ota` dans le
  `.subckt`), sinon le rôle : une paire d'entrée sur deux broches, une diode de miroir, une ou deux sorties. Des
  broches qui n'entrent pas (trois entrées…) gardent la boîte. Le LVS géométrique juge le triangle, pas sa boîte.
- **Figure du top** (D3) : si le top est une figure plate connue, l'ampli (triangle) tenant le rôle de
  l'amplificateur, cette figure remplace le placeur de blocs. Cas du bandgap de Brokaw (`lib/place-brokaw.js`,
  `brokawReading(parsed, { blocks })`) : un triangle dont les deux entrées sont les collecteurs, une seule sortie,
  au plus une broche de polarisation alimentée par une résistance depuis X. La boîte de démarrage n'a que les rails
  et X. Le dessin a des **fils réels** :
  - les collecteurs vont au `+` et au `−` à hauteur des broches ;
  - la sortie va à la grille de MP ;
  - RB va sous `ibias` ;
  - la boîte de démarrage est reliée au bus vref.
  Les chaînes de résistances restent sur le top, sans page `chain_*`. `opts.figure = false` garde le placeur de
  blocs. Moteur de la page : `brokaw`.
- **Liens** (D4) : chaque bloc porte `link="data:page/id,<page>"` vers la page de sa définition (ou de son chemin
  d'instance avec `per=instance`, ou de sa banque) : un clic dans draw.io ouvre le bloc.


### Banc de test, bloc, sous-blocs (correction d'Eric, 26.10)

- Niveaux : page de **banc de test** `tb_<bloc>` (ses sources, le DUT en un seul bloc, les charges) → page du DUT
  (`bandgap`) → pages de sous-blocs modérés (`ota`, `demarrage`). Une page du haut qui n'a que des sources, un bloc
  et des charges R/C/L s'appelle `tb_<bloc>` (`kind: 'testbench'`).
- **Jamais de source sur une page de bloc** : une source V/I sur une autre page que le banc est un avertissement
  `source on block page …` de `?hier=1` et un échec du contrôle `sources` de la porte qualité
  (`qualityGate(model, parsed, { block: true })`). Une page du haut qui mêle sources et circuit est dessinée mais
  signalée : écrire le DUT en `.subckt`.
- Pas de page pour une **primitive du PDK** (`rhigh`, `rppd`, `npn13G2`, `cap_cmim`, `sg13_*`…), même si le deck la
  définit en `.subckt` ; une chaîne de résistances ou une banque reste sur sa page mère sous `GROUP_PAGE_MIN` (12)
  pièces.
- OTA **complet** (deux étages : MP, Cc, Rz dans l'OTA) : la figure Brokaw prend la sortie du triangle comme `vref`,
  sans cadre « Sortie ». Cible : `test/fixtures/hier-brokaw/brokaw_tb.cir`, quatre pages, `test/hier-tb.test.js`.

## LVS

- Par page : le dessin contre sa netlist (corps du `.subckt`, composants de la banque, top avec les blocs).
- **Global** : le dessin aplati à travers les blocs contre la netlist aplatie par le parseur. Chaque bloc est remplacé
  par l'extraction de sa page avec **ses propres nets** : une broche de page (étiquette d'E/S) est reliée au net de la
  borne du bloc, un net dessiné interne est préfixé par le chemin d'instance (ou le nom de la banque), un net caché
  (bulk) garde son nom de netlist. Aucun nom de la référence n'est recopié sur le dessin : un fil coupé sur une page
  reste coupé dans l'aplati (`test/hier-global.test.js`, 6 corruptions). Les directives de
  simulation (`.nodeset`) sont signalées dans `lvs.warnings`, pas en échec.

## Primitives IHP SG13G2

`lib/pdk-ihp.js` : table unique (provenance : xschem `sg13g2_pr/*.sym` d'IHP-Open-PDK, Apache-2.0, commit
`5e6d592e4002946a4616f798c357f0f3c06cf3b6`) : `sg13_{lv,hv}[_rf]_{nmos,pmos}` → M, `rppd/rsil/rhigh` → R (corps
caché), `cap_cmim` / `cap_rfcmim` → C, `npn13G2*` / `pnpMPA` → Q, `dantenna` / `dpantenna` → D. Annotation :
modèle et W/L en µm.

## Tests

`test/hier.test.js` : primitives IHP ; cas multi-instances imbriqué (`fixtures/hier/multi.sp`, écrit pour ce test) par
définition et par instance ; ordre des broches d'un bloc (une liaison permutée échoue) ; TIA `sim/op.cir` (6 banques
en échelle, top ≤ 30) ; TIA proj5 cycle 5 (chaînes, transistors seuls au top, LVS global). `hier-rails.test.js`
(D1), `hier-symbols.test.js` (D2 ; acceptation : Brokaw découpé comme dans le plan,
`fixtures/hier-brokaw/brokaw_hier.cir`), `hier-pages.test.js` (D4, D5), `hier-top.test.js` (D3 ; acceptation : porte qualité 0 échec, LVS géo, par page
et global verts, colonnes Q1/Q2, OTA à côté, boîte de démarrage).

## Limites connues

- Page d'un `.subckt` : une broche dont le net touche plusieurs composants (`ibias` sur la diode MN0) n'a pas
  toujours de port nommé ; le LVS global passe par les bornes, mais la page ne montre pas le nom de la broche.

- Pages de sous-circuit : la qualité est celle du moteur plat (`auto`). L'OTA cascodé du proj5 (41 composants) n'est
  pas lu par le moteur manuel → repli `sa`, peu lisible.
- Top en étiquettes (pas de fils entre blocs).
