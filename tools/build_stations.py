#!/usr/bin/env python3
"""Génère stations.json (référentiel des stations de métro) à partir des
données ouvertes d'Île-de-France Mobilités.

Usage :
    python3 tools/build_stations.py <dossier_gtfs_dezippé> <arrets.json> > stations.json

- GTFS IDFM : https://eu.ftp.opendatasoft.com/stif/GTFS/IDFM-gtfs.zip
  (seuls routes.txt, trips.txt, stops.txt et stop_times.txt sont lus)
- arrets.json : export du jeu « arrets » (quai -> zone d'arrêt) :
  https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/datasets/arrets/exports/json?where=arrtype%3D%22metro%22&select=arrid,arrname,zdaid,arrtown

Pour chaque station, ligne et sens, on garde : l'identifiant de zone d'arrêt
(ZdA, utilisé pour l'appel « prochains passages »), les quais (ZdE) et les
destinations (trip_headsign) des trains qui y prennent des voyageurs.
"""
import collections
import csv
import datetime
import json
import sys

gtfs, arrets_path = sys.argv[1], sys.argv[2]


def rows(name):
    with open(f"{gtfs}/{name}", encoding="utf-8-sig", newline="") as f:
        yield from csv.DictReader(f)


def short(i):
    return i.split(":")[-1]


lines = {}
for r in rows("routes.txt"):
    if r["route_type"] == "1":  # métro
        lines[short(r["route_id"])] = {
            "name": r["route_short_name"],
            "color": r["route_color"].upper(),
            "text": r["route_text_color"].upper(),
        }

trips = {}
for t in rows("trips.txt"):
    lid = short(t["route_id"])
    if lid in lines:
        trips[t["trip_id"]] = (lid, t["direction_id"], t["trip_headsign"].strip())

# (quai, ligne, sens) -> Counter(destination)
agg = collections.defaultdict(collections.Counter)
for st in rows("stop_times.txt"):
    tr = trips.get(st["trip_id"])
    if tr is None or st["pickup_type"] == "1":  # pas de montée (terminus)
        continue
    lid, d, head = tr
    agg[(short(st["stop_id"]), lid, d)][head] += 1

names = {}
for s in rows("stops.txt"):
    names[short(s["stop_id"])] = s["stop_name"].strip()

with open(arrets_path, encoding="utf-8") as f:
    arrets = {a["arrid"]: a for a in json.load(f)}

# station (nom) -> ligne -> {zda, sens -> {quais, Counter}}
stations = collections.defaultdict(lambda: {"towns": collections.Counter(), "lines": {}})
missing = set()
for (quai, lid, d), heads in agg.items():
    a = arrets.get(quai)
    if a is None:
        missing.add(quai)
        continue
    name = names.get(quai) or a["arrname"]
    st = stations[name]
    st["towns"][a.get("arrtown") or ""] += 1
    ln = st["lines"].setdefault(lid, {"zda": set(), "dirs": {}})
    ln["zda"].add(a["zdaid"])
    dd = ln["dirs"].setdefault(d, {"quais": set(), "heads": collections.Counter()})
    dd["quais"].add(quai)
    dd["heads"].update(heads)

if missing:
    print(f"quais sans zone d'arrêt : {sorted(missing)}", file=sys.stderr)


def line_key(lid):
    n = lines[lid]["name"]
    num = int("".join(c for c in n if c.isdigit()) or 0)
    return (num, n)


# Noms des stations où chaque (ligne, sens) prend des voyageurs : une
# destination qui en fait partie est un terminus partiel (ex. « Jules Joffrin »
# sur la 12) et ne figure pas dans le libellé de la direction.
served = collections.defaultdict(set)
for (quai, lid, d) in agg:
    served[(lid, d)].add(names.get(quai, ""))

out = []
for name in sorted(stations, key=lambda s: s.lower()):
    st = stations[name]
    entry = {"n": name, "t": st["towns"].most_common(1)[0][0], "l": []}
    for lid in sorted(st["lines"], key=line_key):
        ln = st["lines"][lid]
        dirs = []
        for d in sorted(ln["dirs"]):
            dd = ln["dirs"][d]
            ranked = [h for h, _ in dd["heads"].most_common()]
            main = [h for h in ranked if h not in served[(lid, d)]] or ranked[:1]
            dirs.append({
                "label": " / ".join(main),
                "quais": sorted(dd["quais"]),
                "heads": ranked,
            })
        if len(ln["zda"]) > 1:
            print(f"{name} ligne {lines[lid]['name']} : plusieurs ZdA {ln['zda']}", file=sys.stderr)
        entry["l"].append({"id": lid, "zda": sorted(ln["zda"]), "dirs": dirs})
    out.append(entry)

json.dump(
    {"generated": datetime.date.today().isoformat(), "lines": lines, "stations": out},
    sys.stdout, ensure_ascii=False, separators=(",", ":"),
)
