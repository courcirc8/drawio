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

> **Corrigé 2026-08-28 — `label_on_wire` était cassé pendant TOUTES les
> itérations E1 ci-dessus ; les scores /100 qu'un `beauty.py` de l'époque
> aurait produits ne sont PAS comparables à ceux d'après le correctif.**
> `tools/beauty.py`'s `label_box`/`label_on_wire` avait un `pass` là où
> l'exclusion du propre fil d'un composant était prévue (le fil qui se
> termine SUR le label de son propre composant comptait toujours comme « le
> traverse »), ce qui gonflait `label_on_wire` pour quasiment tout composant
> étiqueté et connecté — donc pour la quasi-totalité des composants des LNA
> ci-dessus. Le même `beauty.py` avait aussi `min_length` toujours à 0.0 (code
> mort, `sum(hypot(0,0)...)`), ce qui faussait le terme `length`. Mesuré sur
> `rc-filter` (v2, doc sans rendu PNG) : `label_on_wire` 4 → 0 et
> `min_length` 0.0 → 210.0 après correctif, score 75.6 → 87.1 pour la MÊME
> géométrie XML, sans aucun changement de placement. Les comptages bruts
> cités ci-dessus (croisements, coudes) restent des mesures géométriques
> valides — indépendantes de ces deux bugs — et ne sont PAS retirés ; seul un
> score /100 total qui en aurait dérivé à l'époque ne doit pas être reposé
> comme référence face à un score post-correctif. Voir aussi `tools/BEAUTY.md`
> et `beauty.score()`, qui depuis ce correctif refuse d'appeler `score` un
> résultat calculé avec des termes manquants (`score_partial` +
> `missing_terms` à la place) — précisément pour qu'un tel écart de mesure ne
> se reproduise plus en silence.
