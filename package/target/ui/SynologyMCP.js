// Synology MCP: the package's window in the DSM desktop. Plain browser JavaScript, no build step: DSM
// provides Vue 2 (with its template compiler) and its own components (v-app-window, v-tabs, v-input…).
// The window talks to the package's daemon through DSM's web server (/synology-mcp/api, see ../nginx),
// with the DSM session of the administrator, and to DSM's own Web API to set up the reverse proxy.
(function () {
  "use strict";

  SYNO.namespace("SYNO.SDS.SynologyMCP");

  var API = "/synology-mcp/api";
  var SCRIPT_SRC = (document.currentScript && document.currentScript.src) || "";
  var PROXY_DESCRIPTION = "Synology MCP";

  var DOMAINS = [
    { key: "system", label: "Système", desc: "État, ressources, mises à jour, journaux, connexions ; redémarrer ou éteindre le NAS" },
    { key: "storage", label: "Stockage", desc: "Volumes, groupes de stockage, disques" },
    { key: "packages", label: "Paquets", desc: "Lister, démarrer, arrêter, désinstaller des paquets" },
    { key: "containers", label: "Conteneurs", desc: "Container Manager : conteneurs, journaux, images, projets" },
    { key: "files", label: "Fichiers", desc: "File Station : parcourir, chercher, lire, écrire, copier, déplacer, supprimer" },
    { key: "shares", label: "Dossiers partagés", desc: "Dossiers partagés et leurs permissions" },
    { key: "users", label: "Utilisateurs", desc: "Utilisateurs et groupes DSM" },
    { key: "discovery", label: "API DSM", desc: "Appels directs à l'API DSM (en lecture seule : méthodes de lecture seulement)" },
  ];
  var LEVELS = [
    { label: "Désactivé", value: "off" },
    { label: "Lecture seule", value: "ro" },
    { label: "Lecture et écriture", value: "rw" },
  ];

  // --- Requests ----------------------------------------------------------------------------------

  /** The DSM session's anti-CSRF token, required by DSM and by the daemon. */
  function synoToken() {
    try {
      if (typeof _S === "function" && _S("SynoToken")) return _S("SynoToken");
    } catch (e) {}
    try {
      if (SYNO.SDS.Session && SYNO.SDS.Session.SynoToken) return SYNO.SDS.Session.SynoToken;
    } catch (e) {}
    try {
      return new URL(SCRIPT_SRC, location.href).searchParams.get("SynoToken") || "";
    } catch (e) {
      return "";
    }
  }

  /** Calls the package's daemon. */
  function api(method, path, body) {
    var headers = { "X-SYNO-TOKEN": synoToken() };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(API + path, {
      method: method,
      credentials: "same-origin",
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(function (res) {
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          if (res.status === 502 || res.status === 504) throw new Error("Le service Synology MCP ne répond pas : vérifiez qu'il est démarré dans le Centre de paquets.");
          if (!res.ok) throw new Error(data.error || "Erreur " + res.status);
          return data;
        });
    });
  }

  /** Calls DSM's Web API with the administrator's session; these APIs take JSON-encoded parameters. */
  function dsm(apiName, method, version, params) {
    var form = new URLSearchParams({ api: apiName, method: method, version: String(version) });
    Object.keys(params || {}).forEach(function (key) {
      form.append(key, JSON.stringify(params[key]));
    });
    return fetch("/webapi/entry.cgi", {
      method: "POST",
      credentials: "same-origin",
      headers: { "X-SYNO-TOKEN": synoToken() },
      body: form,
    })
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        if (!data.success) {
          var code = data.error && data.error.code;
          throw new Error("DSM a refusé " + apiName + "." + method + " (code " + code + ")");
        }
        return data.data || {};
      });
  }

  // --- Reverse proxy and certificate -------------------------------------------------------------

  function certCovers(name, host) {
    name = String(name || "").toLowerCase();
    host = host.toLowerCase();
    if (name === host) return true;
    if (name.indexOf("*.") === 0) {
      var suffix = name.slice(1);
      var rest = host.slice(0, host.length - suffix.length);
      return host.slice(-suffix.length) === suffix && rest.length > 0 && rest.indexOf(".") === -1;
    }
    return false;
  }

  function certificateFor(certificates, host) {
    var matching = certificates.filter(function (cert) {
      var names = [cert.subject && cert.subject.common_name].concat((cert.subject && cert.subject.sub_alt_name) || []);
      return !cert.is_broken && names.some(function (n) {
        return certCovers(n, host);
      });
    });
    // Prefer the one that renews itself (Let's Encrypt), then the default one.
    matching.sort(function (a, b) {
      return (b.renewable ? 2 : 0) + (b.is_default ? 1 : 0) - ((a.renewable ? 2 : 0) + (a.is_default ? 1 : 0));
    });
    return matching[0];
  }

  function isOurRule(entry, port) {
    var backend = entry.backend || {};
    return (
      entry.description === PROXY_DESCRIPTION ||
      (backend.port === port && (backend.fqdn === "localhost" || backend.fqdn === "127.0.0.1"))
    );
  }

  /** Creates or updates the reverse proxy rule, then gives it a certificate covering the host name. */
  function configureProxy(host, frontendPort, backendPort) {
    var entry = {
      description: PROXY_DESCRIPTION,
      backend: { fqdn: "127.0.0.1", port: backendPort, protocol: 0 },
      frontend: { acl: null, fqdn: host, port: frontendPort, protocol: 1, https: { hsts: true } },
      customize_headers: [{ name: "X-Real-IP", value: "$remote_addr" }],
      proxy_connect_timeout: 60,
      // Long tool calls (folder sizes, searches) answer only when done.
      proxy_read_timeout: 300,
      proxy_send_timeout: 300,
      proxy_http_version: 1,
      // DSM's error pages would hide the server's OAuth errors from Claude.
      proxy_intercept_errors: false,
    };
    return dsm("SYNO.Core.AppPortal.ReverseProxy", "list", 1)
      .then(function (data) {
        var existing = (data.entries || []).filter(function (e) {
          return isOurRule(e, backendPort);
        })[0];
        if (existing) {
          entry.UUID = existing.UUID;
          if (existing._key !== undefined) entry._key = existing._key;
          return dsm("SYNO.Core.AppPortal.ReverseProxy", "update", 1, { entry: entry });
        }
        return dsm("SYNO.Core.AppPortal.ReverseProxy", "create", 1, { entry: entry });
      })
      .then(function () {
        return Promise.all([dsm("SYNO.Core.AppPortal.ReverseProxy", "list", 1), dsm("SYNO.Core.Certificate.CRT", "list", 1)]);
      })
      .then(function (results) {
        var rule = (results[0].entries || []).filter(function (e) {
          return isOurRule(e, backendPort);
        })[0];
        if (!rule) throw new Error("La règle de proxy inversé n'apparaît pas après sa création.");
        var certificates = results[1].certificates || [];
        var cert = certificateFor(certificates, host);
        if (!cert) return { certificate: null };
        var current = certificates.filter(function (c) {
          return (c.services || []).some(function (s) {
            return s.service === rule.UUID;
          });
        })[0];
        if (current && current.id === cert.id) return { certificate: cert };
        var settings = [
          {
            service: {
              display_name: host,
              isPkg: false,
              multiple_cert: true,
              owner: "root",
              service: rule.UUID,
              subscriber: "ReverseProxy",
              user_setable: true,
            },
            old_id: current ? current.id : "",
            id: cert.id,
          },
        ];
        return dsm("SYNO.Core.Certificate.Service", "set", 1, { settings: settings }).then(function () {
          return { certificate: cert };
        });
      });
  }

  // --- Formatting --------------------------------------------------------------------------------

  function formatDate(value) {
    if (!value) return "";
    return new Date(value).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
  }

  function copy(text) {
    if (navigator.clipboard) return navigator.clipboard.writeText(text);
    var area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    document.body.removeChild(area);
    return Promise.resolve();
  }

  var STYLE = [
    ".smcp { height: 100%; display: flex; flex-direction: column; font-size: 13px; color: #414b55; }",
    ".smcp-tabs { flex: 1; min-height: 0; }",
    ".smcp-pane { padding: 4px 20px 20px; }",
    ".smcp h3 { font-size: 14px; font-weight: 600; margin: 18px 0 8px; }",
    ".smcp p { margin: 6px 0; line-height: 1.5; }",
    ".smcp .muted { color: #8a949e; }",
    ".smcp code { font-family: Menlo, Consolas, monospace; font-size: 12px; background: #f2f4f5; padding: 1px 4px; border-radius: 3px; }",
    ".smcp-status { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-radius: 4px; background: #f5f7f8; margin: 14px 0; }",
    ".smcp-dot { width: 12px; height: 12px; border-radius: 50%; flex: none; }",
    ".smcp-dot.ok { background: #3fb950; } .smcp-dot.todo { background: #f0a020; } .smcp-dot.ko { background: #e5534b; }",
    ".smcp-status strong { display: block; font-size: 14px; }",
    ".smcp-status .grow { flex: 1; }",
    ".smcp-copy { display: flex; gap: 8px; align-items: center; margin: 6px 0 10px; }",
    ".smcp-copy code { flex: 1; padding: 6px 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".smcp-row { display: flex; gap: 12px; align-items: center; margin: 10px 0; }",
    ".smcp-row > label { width: 170px; flex: none; }",
    ".smcp-row > .field { flex: 1; max-width: 360px; }",
    ".smcp-actions { display: flex; gap: 8px; margin-top: 16px; }",
    ".smcp-note { padding: 10px 12px; border-left: 3px solid #f0a020; background: #fff8ec; margin: 12px 0; }",
    ".smcp-note.ok { border-color: #3fb950; background: #f0faf2; }",
    ".smcp-note.ko { border-color: #e5534b; background: #fdf0ef; }",
    ".smcp table { width: 100%; border-collapse: collapse; margin-top: 8px; }",
    ".smcp th { text-align: left; font-weight: 600; color: #6b7680; border-bottom: 1px solid #e3e6e8; padding: 7px 8px; }",
    ".smcp td { border-bottom: 1px solid #f0f2f3; padding: 7px 8px; vertical-align: middle; }",
    ".smcp td.desc { color: #6b7680; }",
    ".smcp td.args { font-family: Menlo, Consolas, monospace; font-size: 11px; color: #6b7680; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".smcp .error { color: #c9372c; }",
    ".smcp-empty { padding: 30px 0; text-align: center; color: #8a949e; }",
  ].join("\n");

  function injectStyle() {
    if (document.getElementById("synology-mcp-style")) return;
    var style = document.createElement("style");
    style.id = "synology-mcp-style";
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  // --- Window ------------------------------------------------------------------------------------

  var TEMPLATE = [
    '<v-app-instance class-name="SYNO.SDS.SynologyMCP.Instance">',
    '<v-app-window ref="appWindow" width="940" height="660" :resizable="true" syno-id="SYNO.SDS.SynologyMCP.Window">',
    '<div class="smcp">',
    '<v-tabs class="smcp-tabs" :active-tab-key="tab" @change="tab = $event" :has-fbar="false" :fbar="false">',

    // Overview
    '<v-tab-pane tab-key="overview" tab="Vue d\'ensemble"><div class="smcp-pane">',
    '<div class="smcp-status" v-if="state">',
    '<span class="smcp-dot" :class="statusTone"></span>',
    '<div class="grow"><strong>{{ statusTitle }}</strong><span class="muted">{{ statusDetail }}</span></div>',
    '<v-button v-if="state.status.state === \'needs-account\'" suffix="main" @click="tab = \'account\'">Configurer le compte</v-button>',
    '<v-button v-if="state.status.state === \'needs-public-url\'" suffix="main" @click="tab = \'internet\'">Configurer l\'accès Internet</v-button>',
    '<v-button v-if="state.status.state === \'error\'" @click="restart">Réessayer</v-button>',
    "</div>",
    '<template v-if="state && state.mcpUrl">',
    "<h3>Adresse du serveur MCP</h3>",
    '<div class="smcp-copy"><code>{{ state.mcpUrl }}</code><v-button @click="copy(state.mcpUrl)">Copier</v-button></div>',
    "<h3>Brancher Claude</h3>",
    "<p><strong>claude.ai</strong> (web, bureau, mobile) : Paramètres → Connecteurs → <em>Ajouter un connecteur personnalisé</em>, avec l'adresse ci-dessus.</p>",
    "<p><strong>Claude Code</strong> :</p>",
    '<div class="smcp-copy"><code>{{ claudeCodeCommand }}</code><v-button @click="copy(claudeCodeCommand)">Copier</v-button></div>',
    "<p class=\"muted\">Puis <code>/mcp</code> → <em>Authenticate</em>. La page de connexion demande un compte DSM (et son code de validation en deux étapes) ; les droits sont ceux de l'onglet Droits.</p>",
    "</template>",
    '<p class="muted" v-if="state">Version {{ state.version }}</p>',
    '<p class="error" v-if="loadError">{{ loadError }}</p>',
    "</div></v-tab-pane>",

    // Service account
    '<v-tab-pane tab-key="account" tab="Compte de service"><div class="smcp-pane">',
    "<p>Synology MCP agit sur le NAS avec ce compte DSM, quel que soit l'utilisateur connecté depuis Claude. Utilisez un compte dédié, membre du groupe <em>administrators</em> : ce que Claude peut faire se règle ensuite partie par partie dans l'onglet Droits.</p>",
    '<p v-if="state && state.account">Compte actuel : <strong>{{ state.account.username }}</strong><span class="muted" v-if="state.account.twoFactor"> — appareil approuvé pour la validation en deux étapes</span></p>',
    '<div class="smcp-row"><label>Compte</label><div class="field">',
    '<v-single-select v-if="userOptions.length" v-model="account.username" :options="userOptions" />',
    '<v-input v-else v-model="account.username" placeholder="Nom du compte" />',
    "</div></div>",
    '<div class="smcp-row"><label>Mot de passe</label><div class="field"><v-input v-model="account.password" type="password" :placeholder="sameAccount ? \'Inchangé\' : \'\'" /></div></div>',
    '<div class="smcp-row"><label>Code de validation</label><div class="field"><v-input v-model="account.otpCode" placeholder="Seulement si le compte a la validation en deux étapes" /></div></div>',
    '<p class="muted">Le code à 6 chiffres sert une seule fois : DSM approuve ensuite cet appareil, et le serveur se connecte sans code.</p>',
    '<div class="smcp-actions"><v-button suffix="main" :disabled="busy || !account.username" @click="saveAccount">Vérifier et enregistrer</v-button></div>',
    '<p class="error" v-if="accountError">{{ accountError }}</p>',
    "</div></v-tab-pane>",

    // Internet access
    '<v-tab-pane tab-key="internet" tab="Accès Internet"><div class="smcp-pane">',
    "<p>Claude se connecte au NAS depuis Internet, en HTTPS, par le proxy inversé de DSM. Choisissez un nom d'hôte : la règle de proxy inversé et le certificat sont configurés automatiquement.</p>",
    '<div class="smcp-row"><label>Nom d\'hôte</label><div class="field"><v-input v-model="internet.host" :placeholder="suggestedHost || \'mcp.exemple.synology.me\'" /></div></div>',
    '<div class="smcp-row"><label>Port HTTPS</label><div class="field"><v-input v-model="internet.port" /></div></div>',
    '<p v-if="hostCertificate" class="muted">Certificat : {{ hostCertificate }}</p>',
    '<div class="smcp-note" v-if="internet.host && !hostCertificate && certificatesLoaded">Aucun certificat ne couvre <strong>{{ internet.host }}</strong>. Créez-en un (Let\'s Encrypt) dans Panneau de configuration → Sécurité → Certificat, ou choisissez un nom couvert par un certificat existant.</div>',
    '<div class="smcp-note">Le port {{ internet.port || 443 }} doit être redirigé vers le NAS sur votre box (c\'est déjà le cas si vos autres services DSM sont accessibles en HTTPS).</div>',
    '<div class="smcp-actions">',
    '<v-button suffix="main" :disabled="busy || !internet.host" @click="configureInternet">Configurer</v-button>',
    '<v-button :disabled="busy || !state || !state.publicUrl" @click="testInternet">Tester</v-button>',
    "</div>",
    '<div class="smcp-note" :class="internetResult.tone" v-if="internetResult">{{ internetResult.text }}</div>',
    "</div></v-tab-pane>",

    // Rights
    '<v-tab-pane tab-key="rights" tab="Droits"><div class="smcp-pane">',
    "<p>Ce que Claude peut faire sur chaque partie du NAS, pour tous les comptes qui se connectent. Pris en compte immédiatement.</p>",
    '<table v-if="rights"><thead><tr><th>Partie</th><th>Contenu</th><th style="width:200px">Droit</th></tr></thead><tbody>',
    '<tr v-for="d in domains" :key="d.key"><td><strong>{{ d.label }}</strong></td><td class="desc">{{ d.desc }}</td>',
    '<td><v-single-select v-model="rights.domains[d.key]" :options="levels" /></td></tr>',
    "</tbody></table>",
    "<h3>Comptes autorisés à se connecter</h3>",
    '<p class="muted">Vide : tout compte DSM actif peut se connecter (avec les droits ci-dessus). Le compte de service ne peut jamais se connecter.</p>',
    '<div class="field" style="max-width:520px" v-if="rights"><v-multiple-select v-model="rights.allowedUsers" :options="userOptions" :editable="false" /></div>',
    '<p class="muted"><strong>Lecture et écriture</strong> permet aussi de supprimer des fichiers, désinstaller des paquets ou éteindre le NAS : chaque action de ce type est inscrite au journal.</p>',
    '<div class="smcp-actions"><v-button suffix="main" :disabled="busy || !rights" @click="saveRights">Enregistrer</v-button></div>',
    "</div></v-tab-pane>",

    // Sessions
    '<v-tab-pane tab-key="sessions" tab="Sessions"><div class="smcp-pane">',
    "<p>Les connexions OAuth en cours. Une session dure au plus 90 jours ; la révoquer oblige à se reconnecter.</p>",
    '<div class="smcp-actions"><v-button @click="loadSessions">Actualiser</v-button></div>',
    '<table v-if="sessions.length"><thead><tr><th>Compte</th><th>Application</th><th>Connecté le</th><th>Dernière activité</th><th>Fin</th><th></th></tr></thead><tbody>',
    '<tr v-for="s in sessions" :key="s.family"><td>{{ s.user }}</td><td>{{ s.client }}</td><td>{{ date(s.signedInAt) }}</td><td>{{ date(s.lastUsedAt) }}</td><td>{{ date(s.endsAt) }}</td>',
    '<td><v-button suffix="red" @click="revoke(s)">Révoquer</v-button></td></tr>',
    "</tbody></table>",
    '<div class="smcp-empty" v-else>Aucune session en cours.</div>',
    "</div></v-tab-pane>",

    // Audit log
    '<v-tab-pane tab-key="journal" tab="Journal"><div class="smcp-pane">',
    "<p>Les actions qui modifient le NAS, faites depuis Claude (les lectures ne sont pas inscrites).</p>",
    '<div class="smcp-actions"><v-button @click="loadAudit">Actualiser</v-button></div>',
    '<table v-if="audit.length"><thead><tr><th>Date</th><th>Compte</th><th>Outil</th><th>Résultat</th><th>Paramètres</th></tr></thead><tbody>',
    '<tr v-for="(e, i) in audit" :key="i"><td>{{ date(e.time) }}</td><td>{{ e.user || "—" }}</td><td><code>{{ e.tool }}</code></td>',
    '<td :class="{ error: e.outcome !== \'ok\' }" :title="e.error">{{ e.outcome === "ok" ? "OK" : "Échec" }}</td><td class="args" :title="args(e)">{{ args(e) }}</td></tr>',
    "</tbody></table>",
    '<div class="smcp-empty" v-else>Aucune action pour l\'instant.</div>',
    "</div></v-tab-pane>",

    "</v-tabs>",
    "</div>",
    "</v-app-window>",
    "</v-app-instance>",
  ].join("");

  SYNO.SDS.SynologyMCP.Instance = Vue.extend({
    template: TEMPLATE,
    data: function () {
      return {
        tab: "overview",
        busy: false,
        state: null,
        loadError: "",
        users: [],
        account: { username: "", password: "", otpCode: "" },
        accountError: "",
        internet: { host: "", port: "443" },
        suggestedHost: "",
        certificates: [],
        certificatesLoaded: false,
        internetResult: null,
        rights: null,
        sessions: [],
        audit: [],
        domains: DOMAINS,
        levels: LEVELS,
      };
    },
    computed: {
      statusTone: function () {
        var s = this.state && this.state.status.state;
        return s === "running" ? "ok" : s === "error" ? "ko" : "todo";
      },
      statusTitle: function () {
        switch (this.state && this.state.status.state) {
          case "running":
            return "Le serveur MCP fonctionne";
          case "needs-account":
            return "Compte de service à configurer";
          case "needs-public-url":
            return "Accès Internet à configurer";
          case "error":
            return "Le serveur MCP ne peut pas démarrer";
          default:
            return "";
        }
      },
      statusDetail: function () {
        var status = this.state && this.state.status;
        if (!status) return "";
        if (status.error) return status.error;
        if (status.state === "running") return "Depuis le " + formatDate(status.since);
        if (status.state === "needs-account") return "Choisissez le compte DSM avec lequel le serveur agit.";
        if (status.state === "needs-public-url") return "Choisissez l'adresse par laquelle Claude joint le NAS.";
        return "";
      },
      claudeCodeCommand: function () {
        return "claude mcp add --transport http -s user synology " + ((this.state && this.state.mcpUrl) || "");
      },
      userOptions: function () {
        return this.users.map(function (name) {
          return { label: name, value: name };
        });
      },
      sameAccount: function () {
        var current = this.state && this.state.account;
        return Boolean(current && current.username.toLowerCase() === (this.account.username || "").toLowerCase());
      },
      hostCertificate: function () {
        if (!this.internet.host) return "";
        var cert = certificateFor(this.certificates, this.internet.host.trim());
        if (!cert) return "";
        return (cert.desc || (cert.subject && cert.subject.common_name)) + (cert.renewable ? " (renouvelé automatiquement)" : "");
      },
    },
    watch: {
      tab: function (tab) {
        if (tab === "sessions") this.loadSessions();
        if (tab === "journal") this.loadAudit();
      },
    },
    created: function () {
      injectStyle();
      this.refresh();
      this.loadUsers();
      this.loadInternet();
      this.loadRights();
    },
    methods: {
      date: formatDate,
      args: function (entry) {
        return entry.args === undefined ? "" : JSON.stringify(entry.args);
      },
      msgBox: function () {
        return this.$refs.appWindow.getMsgBox();
      },
      alert: function (title, text) {
        return this.msgBox().alert(title, text);
      },
      copy: function (text) {
        var self = this;
        copy(text).then(function () {
          self.toast("Copié dans le presse-papiers");
        });
      },
      toast: function (text) {
        try {
          this.$refs.appWindow.getToastBox(text);
        } catch (e) {}
      },
      /** Runs one action at a time, with the window's error dialog. */
      run: function (title, action) {
        var self = this;
        if (self.busy) return Promise.resolve();
        self.busy = true;
        return Promise.resolve()
          .then(action)
          .catch(function (err) {
            self.alert(title, err.message);
          })
          .then(function () {
            self.busy = false;
          });
      },
      refresh: function () {
        var self = this;
        return api("GET", "/state")
          .then(function (state) {
            self.state = state;
            self.loadError = "";
            if (state.account && !self.account.username) self.account.username = state.account.username;
            if (state.publicUrl && !self.internet.host) {
              var url = new URL(state.publicUrl);
              self.internet.host = url.hostname;
              self.internet.port = url.port || "443";
            }
            if (state.status.state === "needs-account" && self.tab === "overview" && !state.account) self.tab = "account";
          })
          .catch(function (err) {
            self.loadError = err.message;
          });
      },
      restart: function () {
        var self = this;
        return this.run("Redémarrage", function () {
          return api("POST", "/restart").then(function (state) {
            self.state = state;
          });
        });
      },
      loadUsers: function () {
        var self = this;
        dsm("SYNO.Core.User", "list", 1, { offset: 0, limit: -1 })
          .then(function (data) {
            self.users = (data.users || [])
              .map(function (u) {
                return u.name;
              })
              .filter(function (name) {
                return name !== "guest" && name !== "admin";
              })
              .sort();
          })
          .catch(function () {
            self.users = [];
          });
      },
      saveAccount: function () {
        var self = this;
        self.accountError = "";
        return this.run("Compte de service", function () {
          var body = { username: self.account.username.trim() };
          if (self.account.password) body.password = self.account.password;
          if (self.account.otpCode.trim()) body.otpCode = self.account.otpCode.trim();
          return api("PUT", "/account", body)
            .then(function (state) {
              self.state = state;
              self.account.password = "";
              self.account.otpCode = "";
              self.toast("Compte vérifié et enregistré");
              if (state.status.state === "needs-public-url") self.tab = "internet";
            })
            .catch(function (err) {
              self.accountError = err.message;
            });
        });
      },
      loadInternet: function () {
        var self = this;
        dsm("SYNO.Core.DDNS.Record", "list", 1)
          .then(function (data) {
            var record = (data.records || []).filter(function (r) {
              return r.enable && r.hostname;
            })[0];
            if (record) {
              self.suggestedHost = "mcp." + record.hostname;
              if (!self.internet.host && !(self.state && self.state.publicUrl)) self.internet.host = self.suggestedHost;
            }
          })
          .catch(function () {});
        dsm("SYNO.Core.Certificate.CRT", "list", 1)
          .then(function (data) {
            self.certificates = data.certificates || [];
          })
          .catch(function () {
            self.certificates = [];
          })
          .then(function () {
            self.certificatesLoaded = true;
          });
      },
      configureInternet: function () {
        var self = this;
        self.internetResult = null;
        var host = self.internet.host.trim().toLowerCase();
        var port = Number(self.internet.port || 443);
        return this.run("Accès Internet", function () {
          if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
            throw new Error("Nom d'hôte invalide.");
          }
          if (!(port > 0 && port < 65536)) throw new Error("Port invalide.");
          var backendPort = (self.state && self.state.backendPort) || 8089;
          return configureProxy(host, port, backendPort)
            .then(function (result) {
              var publicUrl = "https://" + host + (port === 443 ? "" : ":" + port);
              return api("PUT", "/public-url", { publicUrl: publicUrl }).then(function (state) {
                self.state = state;
                self.internetResult = result.certificate
                  ? { tone: "ok", text: "Proxy inversé et certificat configurés. Utilisez « Tester » pour vérifier l'accès." }
                  : { tone: "", text: "Proxy inversé configuré, mais aucun certificat ne couvre ce nom : Claude refusera la connexion tant qu'il n'y en a pas." };
              });
            })
            .then(function () {
              return dsm("SYNO.Core.Certificate.CRT", "list", 1).then(function (data) {
                self.certificates = data.certificates || [];
              });
            });
        });
      },
      testInternet: function () {
        var self = this;
        self.internetResult = null;
        return this.run("Test", function () {
          var controller = new AbortController();
          var timer = setTimeout(function () {
            controller.abort();
          }, 10000);
          return fetch(self.state.publicUrl + "/health", { cache: "no-store", signal: controller.signal })
            .then(function (res) {
              self.internetResult = res.ok
                ? { tone: "ok", text: "Le serveur répond à " + self.state.publicUrl + "." }
                : { tone: "ko", text: "Réponse inattendue (HTTP " + res.status + ") : vérifiez la règle de proxy inversé." };
            })
            .catch(function () {
              self.internetResult = {
                tone: "ko",
                text: "Pas de réponse de " + self.state.publicUrl + ". Vérifiez la redirection du port sur la box et le certificat. Depuis le réseau local, certaines box ne savent pas joindre leur propre adresse publique : essayez aussi depuis un téléphone en 4G.",
              };
            })
            .then(function () {
              clearTimeout(timer);
            });
        });
      },
      loadRights: function () {
        var self = this;
        api("GET", "/permissions")
          .then(function (rights) {
            self.rights = { domains: rights.domains, allowedUsers: rights.allowedUsers || [] };
          })
          .catch(function (err) {
            self.loadError = err.message;
          });
      },
      saveRights: function () {
        var self = this;
        return this.run("Droits", function () {
          return api("PUT", "/permissions", { domains: self.rights.domains, allowedUsers: self.rights.allowedUsers }).then(function (rights) {
            self.rights = { domains: rights.domains, allowedUsers: rights.allowedUsers || [] };
            self.toast("Droits enregistrés");
          });
        });
      },
      loadSessions: function () {
        var self = this;
        api("GET", "/sessions")
          .then(function (sessions) {
            self.sessions = sessions;
          })
          .catch(function (err) {
            self.alert("Sessions", err.message);
          });
      },
      revoke: function (session) {
        var self = this;
        this.msgBox()
          .confirm("Révoquer la session", "Déconnecter " + session.user + " (" + session.client + ") ? Il devra se reconnecter.")
          .then(function (answer) {
            if (answer !== "confirm") return;
            return self.run("Sessions", function () {
              return api("DELETE", "/sessions/" + encodeURIComponent(session.family)).then(function () {
                self.loadSessions();
              });
            });
          });
      },
      loadAudit: function () {
        var self = this;
        api("GET", "/audit?limit=300")
          .then(function (entries) {
            self.audit = entries;
          })
          .catch(function (err) {
            self.alert("Journal", err.message);
          });
      },
    },
  });
})();
