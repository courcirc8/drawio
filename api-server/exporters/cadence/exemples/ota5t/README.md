**Sécurité** : aucun accès réseau. Écrit seulement la cellule `MALIB/ota5t_drawio/schematic` (refus si elle existe, sauf `--overwrite`) et `cadence-report.txt`. Les symboles et la table sont seulement lus. skillbridge parle à Virtuoso par une socket locale et écrit ses propres journaux `skillbridge_*.log`.

1. Une fois : `pip install --user skillbridge`, puis `skillbridge path` donne le fichier serveur.
2. Dans le CIW : `load("<fichier serveur>")` puis `pyStartServer`.
3. Dans un terminal : `python3 schema.py --lib MALIB` (ta bibliothèque de travail, déjà existante).
4. Ou sans Python, dans le CIW : `load("schema.il")` puis `cadxExport("MALIB")`.
5. Rapport : `cadence-report.txt`, dans le dossier où tu as lancé la commande (en SKILL : le dossier de démarrage de Virtuoso). Il ne contient que des comptes : envoie-le tel quel.
6. Kit maison : copie `cadence-pdk.map`, adapte-le, puis ajoute `--map mon.map` (SKILL : `?map "mon.map"`).
Deck source : `ota5t.sp`. Doc complète : `docs/cadence.md`.
