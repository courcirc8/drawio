---
name: drawio-api
description: >
  Piloter drawio par API REST (port 8770) pour créer/éditer des schémas
  électroniques : charger un .drawio, ajouter/déplacer/tourner composants et
  fils, autorouter (libavoid), importer une netlist SPICE (placement + câblage
  automatiques), extraire la netlist, LVS, ERC, BOM, exporter PNG/SVG/PDF.
  Utiliser dès que l'utilisateur parle de schéma électronique, drawio,
  netlist, SPICE, LVS ou demande de dessiner/vérifier un circuit.
---

# drawio-api — pilotage de drawio pour schémas électroniques

## Démarrage du serveur

```bash
cd ~/ClaudeCode/test-delegation/drawio/api-server
node server.js --port 8770 &   # ou DRAWIO_API_PORT=8770 npm start
curl -s http://127.0.0.1:8770/health   # {"ok":true}
```

S'il tourne déjà (`/health` répond), ne pas relancer.

## Concepts

- Un **document** = un fichier `.drawio` (XML mxGraphModel) en mémoire, id `docN`.
  `POST /documents` avec `{}` (vide), `{"xml":"<mxfile>…"}` ou `{"path":"/chemin/f.drawio"}`.
- Les **composants** sont des cellules dont l'id sert de référence (R1, C1, V1…).
- Les **pins** viennent des stencils électriques du fork (nommés : `in`, `out`,
  `N`, `S`, `NE`=collecteur/drain, `W`=base/gate, `SE`=émetteur/source).
- Nœud SPICE `0`/`GND` = masse ; chaque terminal de masse reçoit son symbole.

## Séquences types

### Créer un schéma depuis une netlist SPICE (le plus efficace)
```bash
curl -s -X POST :8770/documents -H 'Content-Type: application/json' -d '{}'
curl -s -X POST :8770/documents/doc1/netlist/import -H 'Content-Type: text/plain' \
  --data-binary $'V1 in 0 DC 5\nR1 in out 10k\nC1 out 0 100n\n.end'
# → placement + câblage + autoroutage automatiques
curl -s -o /tmp/schema.png ':8770/documents/doc1/export?format=png&scale=2'
# TOUJOURS regarder le PNG exporté pour vérifier le résultat visuellement
```
(`:8770` = `http://127.0.0.1:8770`)

### Édition manuelle
```bash
# chercher un symbole et ses pins
curl -s ':8770/shapes?q=npn'
# ajouter un composant (w/h par défaut = taille du stencil)
curl -s -X POST :8770/documents/doc1/cells -H 'Content-Type: application/json' \
  -d '{"id":"Q1","shape":"mxgraph.electrical.transistors.npn_transistor_1","x":400,"y":200,"value":"2N2222"}'
# déplacer/tourner/renommer  (dx/dy relatifs, x/y absolus, rotation en degrés)
curl -s -X PATCH :8770/documents/doc1/cells/Q1 -d '{"dx":40,"rotation":90,"value":"BC547"}' -H 'Content-Type: application/json'
# câbler pin à pin (les noms de pins viennent de /shapes)
curl -s -X POST :8770/documents/doc1/wires -H 'Content-Type: application/json' \
  -d '{"from":{"cell":"R1","pin":"out"},"to":{"cell":"Q1","pin":"W"}}'
# re-router après toute édition géométrique
curl -s -X POST :8770/documents/doc1/route -d '{}' -H 'Content-Type: application/json'
```

### Vérification
```bash
curl -s :8770/documents/doc1/netlist            # netlist SPICE extraite
curl -s -X POST :8770/documents/doc1/lvs -H 'Content-Type: text/plain' --data-binary @ref.cir
curl -s :8770/documents/doc1/erc                # pins flottants, nets orphelins…
curl -s :8770/documents/doc1/bom?format=csv
```
LVS : `match` = topologie, `values_match` = valeurs ; `net_mismatches[].hint`
pointe le net le plus proche de l'autre côté.

### Checkpoints / sauvegarde
```bash
curl -s -X POST :8770/documents/doc1/checkpoints -d '{"name":"v1"}' -H 'Content-Type: application/json'
curl -s -X POST :8770/documents/doc1/checkpoints/v1/restore
curl -s -X PUT :8770/documents/doc1/save -d '{"path":"/chemin/schema.drawio"}' -H 'Content-Type: application/json'
```

## Référence rapide

| Endpoint | Rôle |
|---|---|
| `POST /documents` · `GET /documents/:id` (XML) · `DELETE` · `PUT …/save` | cycle de vie |
| `GET /shapes?q=` · `GET /shapes?key=` | catalogue symboles + pins |
| `GET/POST /documents/:id/cells` · `PATCH/DELETE …/cells/:cid` | composants |
| `POST /documents/:id/wires` | fil pin→pin |
| `POST /documents/:id/route` (body `{"wires":[…]}` optionnel) | autoroutage libavoid |
| `POST …/netlist/import` (SPICE) · `GET …/netlist` (`?format=json`) | netlist |
| `POST …/lvs` · `GET …/erc` · `GET …/bom` (`?format=csv`) | vérifs |
| `GET …/export?format=png\|svg\|pdf\|xml&scale=&region=x,y,w,h&pageId=` | export |
| `POST …/checkpoints` · `POST …/checkpoints/:name/restore` | versions |

## Règles de travail

1. Après une édition géométrique → `POST /route` puis re-exporter un PNG et le
   REGARDER (l'export `region=` + `scale=3` permet de zoomer sur une zone).
2. Éléments SPICE supportés : R C L D V I Q (BJT) M (MOSFET, bulk ignoré) et
   G (VCCS = symbole OTA `mxgraph.electrical.abstract.ota_1`, nœud out− ignoré).
   Autres lignes → `warnings`, directives `.xxx` ignorées.
   ATTENTION stencils : les noms de pins sont positionnels (NE/SE/W) ; le PMOS
   est dessiné source EN HAUT (NE=source, SE=drain — géré par
   `PIN_ORDER_OVERRIDES`). Coordonnées exactes de tous les terminaux :
   `api-server/data/electrical-pins.json` (régénérer avec
   `node tools/dump-pins.js`).
3. Les ids de cellules = références SPICE : nommer R1, C2… dès la création
   pour que netlist/LVS/BOM soient cohérents.
4. Le serveur est en mémoire : `PUT …/save` pour persister sur disque.
5. Exemple complet commenté : `examples/ota-biquad.sh` (biquad Gm-C du 2e
   ordre à 2 OTA, câblage par jonctions, routage, LVS propre).
