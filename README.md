# Prochains métros

Petite appli web (installable sur l'écran d'accueil d'un téléphone Android ou d'un iPhone) qui affiche en très gros les deux prochains métros.
Par défaut : **Volontaires (ligne 12), direction Mairie d'Issy**. La loupe en haut à droite permet de choisir n'importe quelle station de métro, puis la ligne et la direction ; cocher « Mémoriser comme station par défaut » pour changer le défaut.

Appli : https://edgarblava.github.io/metro-volontaires/

Les horaires viennent de l'API officielle **PRIM** d'Île-de-France Mobilités. Un petit relais **Cloudflare Worker** ajoute la clé API côté serveur : la clé n'est jamais dans ce dépôt ni dans le navigateur.

---

## 1. Créer la clé PRIM (une fois)

1. Aller sur https://prim.iledefrance-mobilites.fr et cliquer sur **Se connecter** → **Créer un compte**. Valider l'adresse e-mail.
2. Une fois connecté : menu du compte → **Mes jetons d'authentification** (ou « Mon compte » → « Générer ma clé API ») → générer une clé.
3. Si la page des API « Prochains passages (requête unitaire) » ou « Messages Info Trafic (requête unitaire) » propose un bouton **S'abonner**, cliquer dessus.
4. Copier la clé : elle servira à l'étape 2. Ne la mettre nulle part ailleurs.

## 2. Déployer le relais Cloudflare (une fois)

Le relais tourne sur un compte Cloudflare gratuit : `https://metro-volontaires.edgar-272.workers.dev` (déjà déployé, déjà renseigné dans [`config.js`](config.js)).

Pour le redéployer après une modification de `worker/worker.js`, taper dans le terminal du Mac, depuis le dossier `worker` du dépôt (Node.js requis : `brew install node`) :

```bash
npx wrangler@4 deploy
```

Pour changer la clé PRIM (elle est demandée, puis masquée à l'écran) :

```bash
npx wrangler@4 secret put PRIM_API_KEY
```

La première fois, `npx wrangler@4 login` ouvre le navigateur pour autoriser l'accès au compte Cloudflare.

Vérification : https://metro-volontaires.edgar-272.workers.dev/health doit afficher `{"ok":true,"key":true}`.

## 3. Ajouter l'appli à l'écran d'accueil du téléphone

**Android (Chrome)**
1. Ouvrir https://edgarblava.github.io/metro-volontaires/ dans **Chrome**.
2. Toucher le menu **⋮** en haut à droite.
3. Choisir **Installer l'application** (ou **Ajouter à l'écran d'accueil**), puis **Installer**.

**iPhone (Safari)**
1. Ouvrir https://edgarblava.github.io/metro-volontaires/ dans **Safari**.
2. Toucher le bouton **Partager** (carré avec une flèche vers le haut).
3. Choisir **Sur l'écran d'accueil**, puis **Ajouter**.

L'icône « 12 » ouvre directement Volontaires → Mairie d'Issy. Les temps se mettent à jour toutes les 30 secondes et à chaque retour dans l'appli ; toucher les temps force une mise à jour. Après 15 minutes en arrière-plan, l'appli revient d'elle-même à la station par défaut.

---

## Fonctionnement

| Fichier | Rôle |
| --- | --- |
| `index.html`, `style.css`, `app.js` | L'appli (aucune dépendance) |
| `config.js` | Adresse du relais Cloudflare |
| `stations.json` | Les stations de métro, lignes, directions et quais (généré) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installation sur l'écran d'accueil, ouverture hors connexion |
| `worker/worker.js` | Le relais : ajoute la clé, n'accepte que cette appli (CORS), garde les réponses 15 s |
| `tools/build_stations.py` | Régénère `stations.json` |

L'appli interroge `stop-monitoring` sur la zone d'arrêt de la station (ex. `STIF:StopArea:SP:45060:` pour Volontaires), garde la ligne choisie, puis la direction (par le quai, ou à défaut par la destination). Les perturbations viennent de `general-message` pour la ligne.

**Mettre à jour la liste des stations** (nouvelle station ou prolongement) : télécharger le GTFS d'IDFM (https://eu.ftp.opendatasoft.com/stif/GTFS/IDFM-gtfs.zip) et l'export du jeu « arrets » (adresse en tête de `tools/build_stations.py`), puis :

```bash
python3 tools/build_stations.py dossier_gtfs_dezippe arrets.json > stations.json
```

Pour tester en local avec un autre relais : `http://localhost:8000/?worker=http://localhost:8787`.

Données : Île-de-France Mobilités (PRIM), licence ODbL. Projet personnel, sans lien avec la RATP ni IDFM.
