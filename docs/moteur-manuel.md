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
- Nœud de queue au niveau des sources ; nœud de sortie au milieu de la bande entre PMOS et NMOS.
- Grilles : barre partagée entre grilles en regard, diode = boucle locale, grille commandée par un nœud = montée à
  côté de la colonne qui le commande, réseau de grille (diviseur) en échelle.
- Ponts R/C (Miller) horizontaux au niveau de leurs nœuds.
- Un rail et un symbole par cadre ; points de jonction seulement aux T.
- Polarisation et CMFB : cadres « Polarisation » / « CMFB » sous le cœur. Les nets de **polarisation**
  (`vb*`, `vbias*`, `vc[mnp]*`, `vref*`, `vg*`) sont reliés par **étiquettes** ; les nets de **signal** restent des fils.
- Valeurs en notation ingénieur (`100 kΩ`, `497 fF`), W/L en µm, modèle pour les bipolaires.

## Critère « sûr »

`manuelReading` rend `null`, ou le moteur lève une erreur, et `auto` se replie sur les autres moteurs (inchangés), si :

- moins de 3 ou plus de 40 composants, ou un préfixe autre que M, Q, R, C, L, I, V (sous-circuits `X`, sources
  commandées…) ;
- pas de net `0` (ou alias vss/gnd), ou plus d'une alimentation ;
- un transistor hors de toute colonne ; un groupe passif impossible à rattacher ;
- une grille de signal sans règle de fil ; un réseau de grille de plus de 3 chaînes (ou plus d'une sous une barre) ;
- le dessin échoue au LVS topologique ou au LVS géométrique.

## Priorité dans `engine=auto`

1. Lecture sûre et **aucun gabarit** ne lit le circuit → `manuel`.
2. Un gabarit (approuvé par Eric) lit aussi le circuit → les candidats habituels tournent ; `manuel` n'est retenu que
   s'il échoue à **moins** de contrôles de la porte qualité que le dessin élu (égalité : le dessin élu). Ainsi
   `bench:templates` ne peut pas reculer.
3. `AUTO_MANUEL=0` coupe le moteur.

Les fils de rail et les boucles de diode portent `drawioApiTemplate=1`, comme les fils de `lib/rails.js` : ils sont
dessinés exprès et exemptés du contrôle des coudes évitables.

## LVS géométrique

`GET /documents/:id/geo-lvs` → `{ ok, judged, errors, warnings }`. Seuls les fils à tracé fixe (`edgeStyle=none` ou
`drawioApiFixedRoute=1`) sont jugés. Erreurs : `dangling` (fil sans extrémité, jonction à moins de 2 fils),
`tee-no-dot`, `over-pin`, `through-body`, `overlap`, `oblique`. Avertissement : `dot-2` (point visible sur 2 fils).

## Limites connues

- Banque de résistances commutées (bus d'interrupteurs) : lecture `null`, repli.
- Bandgap auto-polarisé : juste, mais les retours de grille se croisent encore.
- Grandes bandes vides verticales dans certaines colonnes de sortie.
