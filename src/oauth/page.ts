const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** No scripts, no framing (clickjacking), no external resources. */
const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

const STYLE = `
:root{--bg:#f5f5f4;--card:#fff;--text:#1c1917;--muted:#57534e;--line:#d6d3d1;--accent:#1d4ed8;--error:#b91c1c;--error-bg:#fef2f2}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--card:#292524;--text:#f5f5f4;--muted:#a8a29e;--line:#44403c;--accent:#60a5fa;--error:#fca5a5;--error-bg:#450a0a}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,sans-serif;padding:16px}
main{width:100%;max-width:400px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px}
h1{font-size:20px;margin:0 0 4px}p{margin:0 0 16px;color:var(--muted)}strong{color:var(--text)}
label{display:block;font-size:14px;margin:12px 0 4px}input{width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);font:inherit}
.error{background:var(--error-bg);color:var(--error);border-radius:8px;padding:10px;margin:0 0 12px}
.actions{display:flex;gap:8px;margin-top:20px}button{flex:1;padding:10px;border-radius:8px;border:1px solid var(--line);font:inherit;cursor:pointer;background:var(--card);color:var(--text)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
`;

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, { status, headers: HEADERS });
}

export interface SignInPage {
  requestId: string;
  clientName: string;
  redirectHost: string;
  account?: string;
  error?: string;
}

export function signInPage({ requestId, clientName, redirectHost, account, error }: SignInPage, status = 200): Response {
  return page(
    "Connexion au NAS",
    `<h1>Connexion au NAS</h1>
<p><strong>${escape(clientName)}</strong> demande à gérer ton NAS. Après connexion, tu seras renvoyé vers <strong>${escape(redirectHost)}</strong>.
Ne continue que si c'est toi qui viens de l'ajouter.</p>
${error ? `<div class="error" role="alert">${escape(error)}</div>` : ""}
<form method="post" autocomplete="on">
<input type="hidden" name="request_id" value="${escape(requestId)}">
<label for="account">Identifiant DSM</label><input id="account" name="account" autocomplete="username" required value="${escape(account ?? "")}">
<label for="password">Mot de passe</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<label for="otp">Code de validation en deux étapes (si activée)</label><input id="otp" name="otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*">
<div class="actions"><button type="submit" name="action" value="deny" formnovalidate>Refuser</button><button class="primary" type="submit" name="action" value="allow">Autoriser</button></div>
</form>`,
    status,
  );
}

export function errorPage(message: string, status = 400): Response {
  return page("Connexion impossible", `<h1>Connexion impossible</h1><p>${escape(message)}</p>`, status);
}
