# Motifs et conventions de dessin dans les schémas publiés (archive IEEE SSCS)

`data/ieee-motifs.json` : statistiques (chiffres seulement, aucun contenu du corpus) tirées de 10 966 schémas
de circuits lisibles de l'archive IEEE SSCS (1955-2008), lus par un modèle de vision local (Ornith) le
2026-10-03. Production : dépôt `local_AI`, `rag/extract/schemas.py` et `rag/docs/inventaire-schemas-ieee.md`.

## Ce que le registre (`lib/motifs.js`) ne nomme pas et que les schémas publiés emploient

Part des schémas lisibles où le motif apparaît (tous types) :

| Motif | Part | Motif | Part |
|---|---|---|---|
| switch (interrupteur MOS, S/H, SC) | 0,23 | resistive-feedback | 0,10 |
| transformer (surévalué par le modèle hors RF) | 0,18 | inductive-degeneration | 0,08 |
| common-gate | 0,14 | bias-network | 0,07 |
| common-source | 0,13 | noise-cancelling | 0,04 |
| source-follower | 0,12 | lc-tank | 0,03 |

Pour comparaison, motifs du registre : differential-pair 0,50, current-mirror 0,46, cross-coupled-pair 0,19,
diode-connected 0,11, inverter 0,09, passive-axis 0,09, cascode 0,06, tail 0,06, latch 0,05.

## Par type de circuit (motifs dominants)

- **LNA** (195) : inductive-degeneration 0,59, differential-pair 0,52, source-follower 0,40, common-gate 0,38.
- **PA** (106) : differential-pair 0,52, inductive-degeneration 0,49, common-source 0,34, common-gate 0,30.
- **mixer** (174) : differential-pair 0,76, switch 0,53, current-mirror 0,45 ; symétrique 0,83.
- **opamp** (470) : differential-pair 0,84, current-mirror 0,79, common-gate 0,31, cascode 0,26 ; symétrique 0,69.
- **VCO** (428) : cross-coupled-pair 0,45, tail 0,28. **reference** (411) : current-mirror 0,75, bias-network 0,25.
- **filter** (293) : switch 0,50 (switched-capacitor). **DAC** (121) : current-mirror 0,64, switch 0,43.

## Conventions de dessin (tous types)

Signal de gauche à droite 0,92 ; alimentation en haut 0,80 (aucune 0,17) ; dessin symétrique 0,40 (mixer 0,83,
opamp 0,69, ADC 0,54, VCO 0,54, reference 0,27, sensor 0,23) ; nombre d'étages : médiane 2.

## Limites

Les étiquettes de motifs viennent du modèle de vision : fiables sur les schémas RF et analogiques simples
(vérifié à l'image sur un pilote de LNA), bruitées sur la logique et les mémoires. Les netlists lues par vision
ne sont pas incluses : leurs nœuds sont incohérents.
