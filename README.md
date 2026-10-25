# synology-mcp-server

Serveur MCP (Bun + TypeScript) qui permet à un agent de gérer un NAS Synology via l'API Web de DSM :
état du système et du stockage, paquets, conteneurs (Container Manager), fichiers (File Station),
dossiers partagés, permissions, utilisateurs et groupes.

Trois façons de l'utiliser :

- **paquet Synology** (recommandé) : installé depuis le Centre de paquets, réglé depuis sa fenêtre dans DSM, partagé
  entre Claude Code, claude.ai et l'app mobile, qui se connectent avec leur compte DSM (OAuth) ;
- **conteneur** : le même serveur dans Container Manager, réglé à la main ;
- **en local** : Claude Code lance le serveur sur le PC (stdio), qui parle au NAS par le réseau.

## Permissions

Ce que le serveur peut faire se règle par partie : dans l'onglet **Droits** de l'application avec le paquet, ou dans
`permissions.yml` (que l'application écrit aussi), une ligne par partie du serveur :

```yaml
system: ro       # état, ressources, mises à jour, journaux, connexions, redémarrage/arrêt
storage: ro      # volumes, groupes de stockage, disques
packages: ro     # paquets DSM : lister, démarrer/arrêter, désinstaller
containers: rw   # Container Manager : conteneurs, journaux, images, projets
files: rw        # File Station : parcourir, chercher, lire/écrire, copier/déplacer, supprimer
shares: ro       # dossiers partagés et leurs permissions
users: ro        # utilisateurs et groupes DSM
discovery: ro    # appels directs à l'API DSM (ro : méthodes de lecture seulement)

# allowed_users:  # comptes DSM autorisés à se connecter au serveur distant (sans cette liste : tous)
#   - leo
```

| Valeur | Effet |
|---|---|
| `off` | aucun outil de cette partie (une partie absente vaut `off`) |
| `ro` | outils de lecture seulement |
| `rw` | tous les outils, y compris supprimer, désinstaller, redémarrer ou éteindre le NAS |

Les outils non permis ne sont **pas exposés** : l'agent ne peut pas les appeler. Le fichier est créé au premier
démarrage, tout en `ro`, dans le dossier de données (`/data` dans le conteneur, `data/` du projet en local, ou
`SYNO_PERMISSIONS_FILE`). Il est relu à chaque requête : une modification s'applique sans redémarrer, et une
modification invalide est ignorée (l'ancienne version reste en vigueur, l'erreur est dans le journal).

Les droits sont les mêmes pour tous ceux qui se connectent. Les outils agissent avec le compte de service
(`SYNO_USERNAME`) ; chaque action qui modifie le NAS est journalisée avec le nom de l'utilisateur, sur stderr et
dans `SYNO_AUDIT_LOG`.

## Compte de service

Créez un compte DSM dédié (par exemple `MCP`). Pour Container Manager, les paquets et les dossiers partagés,
il doit appartenir au groupe **administrators** ; `permissions.yml` limite ensuite ce que l'agent en fait.

DSM impose souvent la 2FA aux administrateurs. Connectez-vous une fois à DSM avec ce compte pour la configurer,
puis obtenez un jeton d'appareil, qui évite de redemander un code :

```bash
bun install
cp .env.example .env              # SYNO_URL, SYNO_USERNAME, SYNO_PASSWORD
bun run device-token 123456       # code 2FA du moment → affiche SYNO_DEVICE_ID
```

## Installer le paquet Synology (recommandé)

```
claude.ai / Claude Code ──HTTPS + jeton OAuth──▶ proxy inversé DSM ──▶ Synology MCP ──API Web──▶ DSM
                                                 (certificat Let's Encrypt)  (127.0.0.1)   (compte de service)
```

Le paquet `SynologyMCP-<version>-x86_64.spk` est construit par GitHub (`.github/workflows/build.yml` : artefact de
chaque build, joint aux releases `v*`), ou en local avec `bun run spk`. DSM 7.2 ou plus, processeur x86-64.

1. **Compte de service** : créer un compte DSM dédié (par exemple `MCP`), membre du groupe *administrators*.
2. **Autoriser les paquets non signés** : Centre de paquets → Paramètres → Général → Niveau de confiance :
   « Synology Inc. et éditeurs de confiance » ne suffit pas, choisir « N'importe quel éditeur ».
3. **Installer** : Centre de paquets → Installation manuelle → choisir le `.spk`. L'assistant demande le compte de
   service (liste des comptes DSM) et son mot de passe.
4. **Ouvrir Synology MCP** depuis le menu principal de DSM :
   - *Compte de service* : saisir le code de validation en deux étapes si le compte en a une (une seule fois : DSM
     approuve ensuite l'appareil) ;
   - *Accès Internet* : choisir le nom d'hôte (par défaut `mcp.<votre DDNS>`), puis **Configurer** : la règle de
     proxy inversé (en-tête `X-Real-IP`, délais de 300 s) et le certificat qui couvre ce nom sont réglés
     automatiquement. Le port (443 par défaut) doit être redirigé vers le NAS sur la box ; **Tester** vérifie
     l'accès ;
   - *Droits* : off / lecture seule / lecture et écriture par partie, et les comptes autorisés à se connecter ;
   - *Vue d'ensemble* : l'adresse à donner à Claude et la commande pour Claude Code ;
   - *Sessions* et *Journal* : les connexions en cours (révocables) et les actions faites sur le NAS.

Le paquet tourne sous son propre utilisateur DSM, sans droits root. Ses données (`settings.json` avec le mot de passe
du compte de service, `permissions.yml`, `oauth.json`, `audit.log`, `synology-mcp.log`) sont dans
`/var/packages/SynologyMCP/var`, lisible par le paquet seul. La fenêtre passe par le serveur web de DSM
(`/synology-mcp/api/`) et n'est accessible qu'aux administrateurs DSM connectés.

**Mettre à jour** : installer le nouveau `.spk` de la même façon ; les réglages sont conservés.

## Autre méthode : conteneur (Container Manager)

L'image `ghcr.io/leomartindev/synology-mcp-server` est construite et publiée par GitHub à chaque modification
(`.github/workflows/build.yml`). Elle tourne aussi sur les processeurs sans AVX2 (Celeron J3455 du DS718+…).

```
claude.ai / Claude Code ──HTTPS + jeton OAuth──▶ proxy inversé DSM ──▶ conteneur synology-mcp ──API Web──▶ DSM
                                                 (certificat Let's Encrypt)   (127.0.0.1 uniquement)   (compte de service)
```

1. **Dossier** : dans File Station, créer `/docker/synology-mcp`. Il contiendra la configuration du projet, qui
   inclut le mot de passe du compte de service : ne le partager qu'avec les administrateurs.
2. **Projet** : Container Manager → Projet → Créer :
   - nom `synology-mcp`, chemin `/docker/synology-mcp`, source « Créer docker-compose.yml » ;
   - coller [`compose.yml`](compose.yml) et remplir les valeurs marquées `À REMPLIR` (adresse publique, compte de
     service, mot de passe, jeton d'appareil) ;
   - Suivant, ignorer le portail web, Terminé : Container Manager télécharge l'image et démarre le conteneur.

   Le journal du conteneur doit afficher `OAuth MCP server on http://0.0.0.0:8080/`. Le fichier
   `/docker/synology-mcp/data/permissions.yml` vient d'être créé (tout en `ro`) : l'ouvrir avec Text Editor pour
   donner les droits voulus, et éventuellement limiter `allowed_users`.
3. **Pare-feu DSM** (s'il est actif) : autoriser le sous-réseau Docker `172.16.0.0/12` vers le port 5001, pour que
   le conteneur joigne DSM. Recommandé aussi : ajouter ce sous-réseau à la liste d'autorisation du blocage
   automatique (Sécurité → Protection), pour qu'une attaque sur la page de connexion ne puisse jamais faire bloquer
   le conteneur par DSM (voir « Protections » plus bas).
4. **Proxy inversé** : Panneau de configuration → Portail de connexion → Avancé → Proxy inversé → Créer :
   - source HTTPS, nom d'hôte `leomartin.synology.me`, port `8443`, HSTS ;
   - destination HTTP `localhost`, port `8089` ;
   - en-tête personnalisé `X-Real-IP` = `$remote_addr` ; délais d'attente portés à 300 s ;
   - puis Sécurité → Certificat → Paramètres : attribuer le certificat Let's Encrypt à cette entrée.
5. **Box** : rediriger le port TCP 8443 vers le NAS. `SYNO_PUBLIC_URL` doit être exactement cette adresse.
   Vérification : `curl -i -X POST https://leomartin.synology.me:8443/mcp` doit répondre `401` avec un en-tête
   `WWW-Authenticate: Bearer … resource_metadata="…"` (et non une page d'erreur de DSM : la découverte OAuth en
   dépend).
6. **Clients** :
   - Claude Code : `claude mcp add --transport http -s user synology https://leomartin.synology.me:8443/mcp`,
     puis `/mcp` → Authenticate : le navigateur ouvre la page de connexion (identifiant DSM, mot de passe, code 2FA) ;
   - claude.ai : Paramètres → Connecteurs → Ajouter un connecteur personnalisé, même URL.

**Mettre à jour** : Container Manager → Projet → `synology-mcp` → Action → Construire (ou Image → mettre à jour) :
la dernière image est téléchargée, `data/` est conservé.

**Couper un accès** : retirer l'utilisateur de `allowed_users` ou désactiver son compte DSM (effet au plus tard une
heure après). **Tout révoquer** : supprimer `data/oauth.json` et redémarrer le conteneur.

### Connexion et protections

- **Connexion** : la page vérifie l'identifiant, le mot de passe et le code 2FA par un vrai login DSM, fermé
  aussitôt ; le serveur ne garde aucun mot de passe d'utilisateur. Tout compte DSM actif peut se connecter, sauf le
  compte de service, et sauf restriction `allowed_users`. L'état du compte et `allowed_users` sont revérifiés à
  chaque rafraîchissement de jeton.
- **Jetons** : opaques, stockés hachés ; accès 1 h, rafraîchissement 30 jours avec rotation, session de 90 jours au
  plus (puis nouvelle connexion DSM + 2FA) ; la réutilisation d'un ancien jeton révoque toute la session.
  PKCE S256 obligatoire.
- **Protections** : adresses de retour limitées à une liste blanche (`SYNO_OAUTH_REDIRECT_URIS`, par défaut
  claude.ai et localhost) ; page qui indique l'application et l'adresse de retour ; connexions traitées une à une,
  limitées à 5 échecs par IP ou par compte en 15 min, 5 tentatives par demande et 8 échecs au total en 5 min
  (`SYNO_SIGNIN_GLOBAL_LIMIT`) ; tailles bornées pour tout ce qu'une requête anonyme peut faire stocker.

DSM voit toutes les connexions venir du serveur (du conteneur, ou de 127.0.0.1 avec le paquet) : si son blocage automatique bloquait cette adresse, le compte de
service serait bloqué aussi, et tout le serveur avec. La limite globale reste donc sous son seuil (10 échecs en
5 min par défaut), au prix d'un blocage de quelques minutes pour tout le monde en cas d'attaque. Une fois le
sous-réseau Docker sur la liste d'autorisation de DSM (étape 3), `SYNO_SIGNIN_GLOBAL_LIMIT: "0"` lève cette limite ;
les limites par IP et par compte restent.

Essai du mode distant sur le PC, sans HTTPS (accepté seulement pour localhost) :

```bash
SYNO_TRANSPORT=http SYNO_PUBLIC_URL=http://localhost:8787 SYNO_HTTP_PORT=8787 bun --env-file=.env src/index.ts
claude mcp add --transport http synology-test http://localhost:8787/mcp   # puis /mcp → Authenticate
```

## Utiliser en local (stdio)

```bash
bun install
cp .env.example .env   # URL, compte de service, 2FA
bun run smoke          # test de connexion en lecture seule
claude mcp add synology -- bun --env-file=C:/chemin/synology-mcp-server/.env C:/chemin/synology-mcp-server/src/index.ts
```

Les droits viennent de `data/permissions.yml` dans le dossier du projet, créé au premier lancement.

Toute variable `SYNO_<NOM>` peut être remplacée par `SYNO_<NOM>_COMMAND` (une commande dont la sortie donne la
valeur, exécutée au démarrage) ou par `SYNO_<NOM>_FILE` (un fichier qui la contient) :

```bash
SYNO_PASSWORD_COMMAND=op read "op://Private/Synology MCP/password"   # 1Password CLI
SYNO_PASSWORD_COMMAND=bw get password synology-mcp                   # Bitwarden CLI
```

Avec le CLI 1Password et plusieurs comptes, ajoutez `OP_ACCOUNT=<adresse de connexion>` (voir `op account list`).

Pour la 2FA du compte de service, au choix :

| Méthode | Variable | Principe |
|---|---|---|
| Jeton d'appareil | `SYNO_DEVICE_ID`, via `bun run device-token 123456` | DSM mémorise l'appareil ; plus de code demandé |
| Commande | `SYNO_OTP_COMMAND=op read "op://…/one-time password?attribute=otp"` | un code frais est demandé à chaque connexion |
| Secret TOTP | `SYNO_TOTP_SECRET=<base32 ou URI otpauth://>` | le serveur calcule les codes lui-même |

## Outils

Un dossier par partie dans `src/tools/`, chacune réglée par la ligne du même nom dans `permissions.yml` :

| Partie | Outils (`ro`) | Outils ajoutés par `rw` |
|---|---|---|
| `system` | `system_info`, `system_utilization`, `dsm_update_check`, `system_logs`, `system_connections` | `system_reboot`, `system_shutdown` |
| `storage` | `storage_info` (volumes, groupes de stockage, disques et SMART) | — |
| `packages` | `package_list` | `package_start`, `package_stop`, `package_uninstall` |
| `containers` | `container_list`, `container_get`, `container_logs`, `container_stats`, `image_list`, `project_list` | `container_start`, `container_stop`, `container_restart`, `container_delete` |
| `files` | `file_list_shares`, `file_list`, `file_info`, `dir_size`, `file_search`, `file_read`, `file_task_status` | `file_write`, `folder_create`, `file_rename`, `file_copy`, `file_move`, `file_delete` |
| `shares` | `share_list`, `share_get`, `share_permission_list` | `share_create`, `share_permission_set`, `share_delete` |
| `users` | `user_list`, `group_list`, `group_members` | — |
| `discovery` | `syno_api_list`, `syno_api_call` (méthodes de lecture) | `syno_api_call` sans restriction |

Les horodatages Unix des réponses DSM sont convertis en dates ISO (UTC), et les tailles des outils de synthèse
sont données en unités lisibles. `syno_api_list` + `syno_api_call` permettent d'atteindre n'importe quelle API DSM
non encore couverte.

## Développement

```bash
bun test          # tests avec un faux NAS en mémoire
bun run typecheck
SYNO_DEBUG=true   # trace chaque appel API (mots de passe masqués) sur stderr
```

Structure : `src/synology/` (client DSM : découverte des API, session, téléchargement et envoi de fichiers, erreurs),
`src/permissions.ts` (fichier de permissions), `src/http.ts` et `src/oauth/` (serveur distant : routes, serveur
d'autorisation, comptes DSM, jetons, page de connexion), `src/tools/<partie>/` (un dossier par partie, son
`index.ts` enregistre ses outils), `src/tools/toolbox.ts` (enregistrement selon les permissions, audit),
`src/tools/format.ts` (dates et tailles lisibles).

Pour ajouter une partie : l'ajouter à `DOMAINS` dans `src/permissions.ts` (et au fichier par défaut), créer
`src/tools/<partie>/index.ts` qui exporte `register<Partie>Tools(tb)`, puis l'appeler dans `src/tools/index.ts`
avec `tb.forDomain("<partie>")`.

### À savoir sur l'API DSM

Seules File Station et l'authentification sont documentées officiellement par Synology. Les API
`SYNO.Docker.*` et `SYNO.Core.*` (partages, permissions, utilisateurs) ne le sont pas : leurs paramètres
viennent de l'interface web de DSM et peuvent varier selon la version. L'encodage des paramètres suit
le `requestFormat` annoncé par `SYNO.API.Info` pour chaque API.

Les outils de lecture ont été vérifiés sur un DS718+ sous DSM 7.2. Les outils `rw` reprennent les appels de
l'interface DSM mais n'ont pas tous été exécutés sur un vrai NAS : `package_start`/`stop`/`uninstall`,
`file_write`, `system_reboot` et `system_shutdown` sont à valider avec `SYNO_DEBUG=true` au premier usage.
