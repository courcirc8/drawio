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
