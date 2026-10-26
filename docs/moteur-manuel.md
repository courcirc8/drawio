# Moteur « manuel » et LVS géométrique

Décision de l'Orchestrateur (24.10.2026, autonomie déléguée par Eric) : un moteur qui dessine comme les manuels
(Razavi, Gray-Meyer, Johns-Martin), prioritaire quand sa lecture est sûre, avec un LVS géométrique obligatoire.

## Fichiers

| Fichier | Rôle |
|---|---|
| `api-server/lib/manuel-reading.js` | lecture : rails, cadres (cœur / polarisation / CMFB), colonnes de courant, paires miroir, chaînes R-C, nets étiquetés ; `null` si la lecture n'est pas sûre |
| `api-server/lib/place-manuel.js` | placement et câblage par règles (pas de routeur), annotations, cadres en pointillés |
| `api-server/lib/geo-lvs.js` | LVS géométrique : la connectivité visible contre la connectivité déclarée |
| `api-server/lib/auto.js` | `tryManuel`, `templateReads` : priorité dans `engine=auto` |
| `api-server/test/manuel.test.js` | critère « sûr », LVS + LVS géométrique sur les blocs du TIA, cas négatifs |

## Dessin

- Une colonne par branche DC (rail haut → rail bas par les canaux), PMOS empilés depuis le haut, NMOS depuis le bas,
  rangées alignées d'une colonne à l'autre ; une résistance en série dans une branche reste dans la colonne.
- Colonnes appariées (mêmes tailles, nets symétriques) en miroir autour d'un axe ; étages suivants vers l'extérieur.
- **Source de queue sur l'axe** (règle d'Eric, 25.10) : le transistor de queue d'une paire différentielle est centré
  entre les deux transistors, sur l'axe de symétrie, en dessous d'une paire NMOS, au-dessus d'une paire PMOS alimentée
  par le haut. Mesure sur le **canal** (broches drain/source), pas sur la boîte du symbole décalée par la grille ;
  tolérance une grille (10). Test : `test/tail-axis.test.js` (OTA Miller N et P, 5T N et P, StrongARM, folded
  cascode, en `auto` et en `manuel`).
- Nœud de queue au niveau des sources de la paire (N : la queue monte dessus ; P : la queue descend dessus) ; nœud de
  sortie au milieu de la bande entre PMOS et NMOS.
- Grilles : barre partagée entre grilles en regard, diode = boucle locale, grille commandée par un nœud = montée à
  côté de la colonne qui le commande, réseau de grille (diviseur) en échelle.
- Ponts R/C (Miller) horizontaux au niveau de leurs nœuds.
- Un rail et un symbole par cadre ; points de jonction seulement aux T.
- Polarisation et CMFB : cadres « Polarisation » / « CMFB » sous le cœur. Les nets de **polarisation**
  (`vb*`, `vbias*`, `vc[mnp]*`, `vref*`, `vg*`) sont reliés par **étiquettes** ; les nets de **signal** restent des fils.
- **OTA cascodé télescopique** (OTA du TIA proj5, 26.10, `test/cascode-ota.test.js`) :
  - **Répliques de polarisation** : une branche en série avec une diode, un seul bout sur un rail et l'autre sur un
    nœud de colonne du cœur, va dans « Polarisation ». Cela vaut pour MBN + RBN vers `tail` ou MPD/MQ1, à condition
    que ses grilles soient sa diode, un net de polarisation ou une entrée. Exclus : un nœud de diode qui attaque une
    paire d'entrée (branche de cœur d'un bandgap vers son ampli, analoggenie/1504) et la référence d'un miroir dont
    la sortie est sur le même nœud d'attache.
  - **Démarrage** : un transistor du cœur dont la grille n'est commandée que par un RC vers les rails (au moins une
    résistance et une capacité ; un diviseur R, une source ou des capacités seules sont une polarisation) va dans
    le cadre « Démarrage », avec ces passifs. C'est le cas du kick XKA/XKB par RPOR/CPOR. Un groupe passif entre
    rails seulement (alimentation, source de banc, découplage) n'y va jamais.
  - Les chaînes passives entre cadres s'arrêtent sur un net partagé avec un autre cadre ; le degré du net est compté
    sur tout le circuit.
  - **Branche R ∥ C** de détection (RCMA ∥ CCMA) : un seul échelon, avec le partenaire dessiné à côté et relié aux
    deux bouts. Le nom du bout haut est posé dans l'axe de l'échelon, sans coude. Ailleurs, seulement pour une
    étiquette : un port posé ainsi peut tomber sur une broche (casc_amp, analoggenie/230).
  - Non-régression sur le corpus : `test/manuel-corpus-regress.test.js` (netlists MIT du bank).
  - **Paire du CMFB** en miroir : la grille de référence (`vcmref`) sort du côté extérieur, comme celle de sa
    partenaire.
- **Échelle entre deux bus** (banque de capacités / résistances commutées) : quand la lecture en colonnes échoue,
  `ladderReading` cherche deux bus A et B reliés par des tranches en série (une capacité, un interrupteur…) ; les
  autres composants sont des éperons d'un nœud de tranche vers un net commun (étiquette, ex. `vg`) ou un port ; les
  grilles d'interrupteurs sont des ports de commande, ou portent une **source de grille** (V/I d'une seule grille vers
  la masse ou un net commun, banques du TIA hiérarchique) dessinée pendue à la grille, bus B en dessous. Dessin : bus A en haut, bus B en bas, une tranche par colonne,
  la tranche directe en premier, éperons horizontaux à droite.
- **Bandgap de Brokaw** (`lib/place-brokaw.js`, demande d'Eric du 25.10) : quand la lecture en colonnes échoue,
  `brokawReading` lit les rôles (paire NPN de même base, chaînes R de collecteur vers la sortie X, R1 sous le grand
  émetteur, R2 vers la masse, diviseur de base, amplificateur d'erreur MOS à miroir P, queue et diode de
  polarisation, transistor de sortie, compensation R-C, charges, démarrage = pile série + transistors pendus).
  Dessin en quatre cadres de gauche à droite : « Démarrage », « Cœur » (Q1 / Q2 côte à côte, rapport d'aires écrit
  `A (×m)` / `nA (×m)`, R1 / R2 sous les émetteurs), « Amplificateur d'erreur » (miroir en haut, paire, queue sur
  l'axe), « Sortie » (port vref, alimentation de banc à part). Formes acceptées : primitives SPICE ou primitives
  IHP en `X` à résistances fractionnées. Test : `test/brokaw.test.js`.
- Valeurs en notation ingénieur (`100 kΩ`, `497 fF`), W/L en µm, modèle pour les bipolaires.

## Critère « sûr »

`manuelReading` rend `null`, ou le moteur lève une erreur, et `auto` se replie sur les autres moteurs (inchangés), si :

- moins de 3 ou plus de 40 composants, ou un préfixe autre que M, Q, R, C, L, I, V (sous-circuits `X`, sources
  commandées…) ;
- pas de net `0` (ou alias vss/gnd), ou plus d'une alimentation — sauf lecture en échelle (ci-dessous) ;
- un transistor hors de toute colonne ; un groupe passif impossible à rattacher ;
- une grille de signal sans règle de fil ; un réseau de grille de plus de 3 chaînes (ou plus d'une sous une barre) ;
- le dessin échoue au LVS topologique ou au LVS géométrique.

Échelle (repli de la lecture en colonnes) : seulement M, R, C, L (et V, I comme sources de grille) ; 6 à 60 composants ; au moins 3 tranches ; les
tranches ne partagent aucun nœud interne ; un transistor de tranche est entré par sa borne haute et sa grille est
une commande (net propre ou net de polarisation) ; un seul éperon par nœud.

## Priorité dans `engine=auto`

1. Lecture sûre et **aucun gabarit** ne lit le circuit → `manuel`.
2. Un gabarit (approuvé par Eric) lit aussi le circuit → les candidats habituels tournent ; `manuel` n'est retenu que
   s'il échoue à **moins** de contrôles de la porte qualité que le dessin élu (égalité : le dessin élu). Ainsi
   `bench:templates` ne peut pas reculer.
   Exception : le gabarit `ldo` (approuvé par Eric) reste élu même si `manuel` échoue à moins de contrôles
   (Orchestrateur, 26.10) ; l'écart est rapporté dans `manuelVs`.
3. `AUTO_MANUEL=0` coupe le moteur.

Les fils de rail et les boucles de diode portent `drawioApiTemplate=1`, comme les fils de `lib/rails.js` : ils sont
dessinés exprès et exemptés du contrôle des coudes évitables.

## LVS géométrique

`GET /documents/:id/geo-lvs` → `{ ok, judged, errors, warnings }`. Seuls les fils à tracé fixe (`edgeStyle=none` ou
`drawioApiFixedRoute=1`) sont jugés. Erreurs : `dangling` (fil sans extrémité, jonction à moins de 2 fils),
`tee-no-dot`, `over-pin`, `through-body`, `overlap`, `oblique`. Avertissement : `dot-2` (point visible sur 2 fils).

## Netlists hiérarchiques

Voir `docs/hierarchie.md` (`?hier=1`).

## Limites connues

- Banque commutée : le bulk des interrupteurs n'est pas dessiné (comme ailleurs).
- Grandes bandes vides verticales dans certaines colonnes de sortie.
