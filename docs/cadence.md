# Schéma vers Cadence Virtuoso

drawio écrit un script qui dessine le schéma dans Virtuoso, puis le vérifie.
Deux versions au choix :

- **Python** (`schema.py`), via skillbridge ;
- **SKILL pur** (`schema.il`), sans aucune dépendance.

## 1. Installer skillbridge (une fois, version Python seulement)

```sh
pip install --user skillbridge
skillbridge path        # affiche le chemin du fichier .il serveur
```

## 2. Lancer

**Python.** Dans le CIW de Virtuoso :

```lisp
load("<chemin donné par skillbridge path>")
pyStartServer
```

Puis dans un terminal :

```sh
python3 schema.py --lib MALIB
```

**SKILL pur.** Dans le CIW :

```lisp
load("schema.il")
cadxExport("MALIB")
```

Options :

| Python | SKILL | Effet |
|---|---|---|
| `--cell nom` | `?cell "nom"` | nom de la cellule |
| `--map mon.map` | `?map "mon.map"` | symboles de ton kit |
| `--overwrite` | `?overwrite t` | remplace une cellule existante |
| `--detail` | `?detail t` | noms des écarts, **pour toi seulement** |

Sans `--overwrite`, une cellule existante n'est jamais touchée. La bibliothèque doit déjà exister.

## 3. Symboles de ton kit (`--map`)

Par défaut, les symboles viennent de `analogLib` (nmos4, pmos4, res, cap, ind, vdc, idc, gnd) et de `basic` (iopin).

Pour les MOS du PDK, copie `cadence-pdk.map` et ajoute par exemple :

```
model.nch = mynmos
mynmos.lib = MONPDK
mynmos.cell = nch
mynmos.terms = D G S B
mynmos.param.w = w
mynmos.param.l = l
```

`terms` donne les noms des terminaux dans l'ordre SPICE (drain, grille, source, bulk). Un paramètre absent du deck n'est jamais écrit : aucune valeur n'est inventée.

Ce fichier reste chez toi. Ni le script ni le rapport ne renvoient ses noms.

## Second passage exact (option)

Le premier passage relie chaque broche à son point prévu par un petit fil (« stub »). Pour supprimer ces stubs :

1. Relance le script en ajoutant `--write-profile profil.json` (SKILL : `?writeProfile "profil.json"`). Le fichier contient les points des terminaux de tes symboles, rangés par rôle (nmos, pmos, res…), sans aucun nom de bibliothèque. **Il reste chez toi.**
2. Là où drawio est installé : `node api-server/exporters/cadence/cli.mjs deck.sp --profile profil.json --out dossier`. Le moteur place alors directement sur les vraies broches.

Résultat sur le faux Virtuoso : OTA, Miller et comparateur CML passent de 17 à 25 stubs à 0. Pour le LNA et le VCO, drawio garde le premier passage, car leurs gabarits supposent le pochoir d'inductance de draw.io ; la sortie indique alors « not used ».

## 4. Lire le rapport (`cadence-report.txt`)

```
result: PASS
instances: expected 6, created 6
opens: 0, shorts: 0, ground wrong: 0
ports: 2/2
schCheck: errors 0, warnings 0
wires: segments 31, stubs 4 (length 1.25), label fallbacks 0, bulk labels 6
instance overlaps: 0
```

- **PASS** : la connectivité relue dans Virtuoso, après `schCheck`, est exactement celle du deck. Il n'y a aucun circuit ouvert (open), aucun court-circuit (short), la masse est sur `gnd!` et les ports portent leur nom.
- **stubs** : petits fils en L entre la broche réelle du symbole et le point prévu. Beaucoup de stubs ou des `instance overlaps` signifient que l'échelle du dessin ne convient pas à tes symboles : envoie-moi le rapport.
- **label fallbacks** : une broche reliée par un label faute de place pour un fil.

Le rapport ne contient que des comptes : aucun nom de bibliothèque, de cellule, de paramètre ou de chemin. Tu peux me l'envoyer tel quel. Le script n'utilise pas le réseau (skillbridge parle à Virtuoso par une socket locale).

## Limites connues

- Le script n'a jamais tourné sur un vrai Virtuoso. Il est testé ici sur un faux Virtuoso, et la version SKILL sur un petit interpréteur SKILL. Ton premier rapport sert de vrai test.
- Le placement est calculé avec les symboles draw.io, puis recalé sur les vraies broches. Il peut rester des stubs et des chevauchements tant qu'on n'a pas calibré l'échelle sur tes symboles.
- Composants pris en charge : R, C, L, V et I (valeur DC), MOS. Les sources SIN/PULSE sont posées sans valeur (compté dans `params skipped`).
- Le bulk est relié par un label portant le nom de son net.
