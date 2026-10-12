# Promotion — drawio-api

- **Nom** : `drawio-api`
- **Mise à jour** 1.1.0 (CHANGELOG : périmètre resserré sur l'édition ; netlist → schéma et LVS renvoyés vers
  `schema-depuis-netlist`).
- **Usage** : éditer un schéma drawio existant par l'API REST locale (port 8770).

## Doit déclencher
- « Déplace M3 sous M1 et reroute les fils. »
- « Fais l'ERC de ce schéma drawio. »
- « Sors la nomenclature (BOM) de ce schéma. »
- « Exporte ce .drawio en SVG. »

## Ne doit pas déclencher
- « Dessine-moi le schéma de cette netlist SPICE. » (→ schema-depuis-netlist)
- « Vérifie que ce schéma correspond à la netlist (LVS). » (→ schema-depuis-netlist)
- « Simule ce circuit avec ngspice. »

## Tests
Aucun changement de code (description seulement).

## Provenance
Dépôt `courcirc8/drawio`, branche `skill-drawio-api-perimetre`, dossier `api-server/skill/drawio-api` ; machine ai-station.
