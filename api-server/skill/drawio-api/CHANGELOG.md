# Changelog — drawio-api

## 1.1.0 — 13.10.2026
- Périmètre resserré sur l'ÉDITION d'un schéma existant (déplacer, router, ERC, BOM, export) ; la conversion netlist →
  schéma et le LVS sont renvoyés vers le skill `schema-depuis-netlist` (skills-micro), pour éviter le doublon de
  déclenchement relevé par l'Intégrateur.
