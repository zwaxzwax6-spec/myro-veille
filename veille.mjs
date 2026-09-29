// Veille externe des funnels Myro — Node 20, aucune dépendance.
// Lancé toutes les 10 min par GitHub Actions ; l'état des incidents = issues ouvertes « incident ».
// RIEN de sensible ne doit sortir d'ici : statut, URL publique, motif court uniquement.

import { pathToFileURL } from "node:url";
import { appendFileSync } from "node:fs";

export const UA = "Mozilla/5.0 (myro-veille)";
export const DELAI_MS = 20_000;
export const MAX_SAUTS = 5;
export const PAUSE_REESSAI_MS = 10_000;
export const AGE_MAX_BATTEMENT_MIN = 15;
export const LABEL = "incident";

// ---------- Définition des contrôles ----------

function controlesFunnel(prefixe, base, cle) {
  return [
    {
      id: `${prefixe}-freecourse`,
      url: `${base}/freecourse`,
      maxRedirections: 1,
      marqueurs: [`/api/m/tag/${cle}/formation.js`, "/evergreen/comportements.js"],
    },
    {
      id: `${prefixe}-webinaire`,
      url: `${base}/webinaire`,
      maxRedirections: 1,
      marqueurs: [`/api/m/tag/${cle}/webinaire.js`, "/wb/v2/comportements.js"],
    },
    {
      id: `${prefixe}-business`,
      url: `${base}/business`,
      maxRedirections: 1,
      marqueurs: ['id="root"'],
      scriptLovable: true, // /assets/index-….js doit exister et répondre 200
    },
  ];
}

export function construireControles(env = {}) {
  const liste = [
    ...controlesFunnel("corsetti", "https://corsetticonsulting.com", "nicolas"),
    ...controlesFunnel("nabil", "https://nabildrive.com", "nabil"),
    {
      id: "myro-kpi",
      url: "https://myro-kpi.vercel.app/",
      maxRedirections: 1,
      cheminFinal: "/login",
      marqueurs: ["Connexion · Myro"],
    },
  ];
  if ((env.BATTEMENT_ACTIF || "").trim() === "1") {
    liste.push({ id: "battement-vps", type: "battement", url: "(variable BATTEMENT_VPS)" });
  }
  const urlTest = (env.URL_TEST_PANNE || "").trim();
  if (urlTest) liste.push({ id: "url-test", url: urlTest, maxRedirections: MAX_SAUTS, marqueurs: [] });
  return liste;
}

// ---------- Fonctions pures ----------

/** Décide si le saut suivant boucle : URL déjà vue ou trop de sauts. */
export function detecterBoucle(vues, suivante, maxSauts = MAX_SAUTS) {
  if (vues.includes(suivante)) return `boucle de redirection (${suivante} déjà vue)`;
  // vues contient l'URL de départ : le nombre de sauts faits = vues.length - 1
  if (vues.length > maxSauts) return `plus de ${maxSauts} redirections`;
  return null;
}

/** Extrait le script principal Lovable (/assets/index-….js). */
export function extraireScriptLovable(corps) {
  const m = /["'](\/assets\/index-[A-Za-z0-9_-]+\.js)["']/.exec(corps || "");
  return m ? m[1] : null;
}

/**
 * Analyse le résultat d'un parcours HTTP pour un contrôle.
 * resultat = { statut, sauts, urlFinale, corps, erreur? }
 * Renvoie { ok, motif, script? }.
 */
export function analyserReponse(controle, resultat) {
  if (resultat.erreur) return { ok: false, motif: resultat.erreur };
  if (resultat.statut !== 200) return { ok: false, motif: `HTTP ${resultat.statut}` };
  const max = controle.maxRedirections ?? 1;
  if (resultat.sauts > max) return { ok: false, motif: `${resultat.sauts} redirections (max ${max})` };
  if (controle.cheminFinal) {
    const chemin = new URL(resultat.urlFinale).pathname;
    if (chemin !== controle.cheminFinal) return { ok: false, motif: `arrive sur ${chemin} au lieu de ${controle.cheminFinal}` };
  }
  for (const m of controle.marqueurs || []) {
    if (!(resultat.corps || "").includes(m)) return { ok: false, motif: `marqueur absent : ${m}` };
  }
  if (controle.scriptLovable) {
    const script = extraireScriptLovable(resultat.corps);
    if (!script) return { ok: false, motif: "script /assets/index-….js absent" };
    return { ok: true, motif: "", script };
  }
  return { ok: true, motif: "" };
}

/** Évalue la valeur « <ISO8601> <etat> » du battement VPS. */
export function evaluerBattement(valeur, maintenant = new Date()) {
  const v = (valeur || "").trim();
  if (!v) return { ok: false, motif: "battement absent" };
  const [horodatage, ...reste] = v.split(/\s+/);
  const etat = reste.join(" ");
  const t = Date.parse(horodatage);
  if (Number.isNaN(t) || !etat) return { ok: false, motif: "battement illisible" };
  const ageMin = Math.round((maintenant.getTime() - t) / 60_000);
  if (ageMin > AGE_MAX_BATTEMENT_MIN) return { ok: false, motif: `battement vieux de ${ageMin} min`, ageMin };
  if (etat.startsWith("erreur")) {
    const motif = etat.slice("erreur".length).replace(/^:\s*/, "").trim();
    return { ok: false, motif: `VPS en erreur${motif ? " : " + motif : ""}`.slice(0, 120), ageMin };
  }
  if (etat !== "ok") return { ok: false, motif: "battement illisible", ageMin };
  return { ok: true, motif: "", ageMin };
}

/** Id du contrôle d'après le titre d'issue « [id] … ». */
export function idDepuisTitre(titre) {
  const m = /^\[([^\]]+)\]/.exec(titre || "");
  return m ? m[1] : null;
}

/**
 * Décision d'état pour un contrôle.
 * 'ouvrir' (nouvelle panne), 'toujours' (panne déjà connue), 'retablir', 'rien'.
 */
export function deciderAction(ok, issueOuverte) {
  if (!ok) return issueOuverte ? "toujours" : "ouvrir";
  return issueOuverte ? "retablir" : "rien";
}

export function dureeMinutes(depuisIso, maintenant = new Date()) {
  return Math.max(0, Math.round((maintenant.getTime() - Date.parse(depuisIso)) / 60_000));
}

export function heureUtc(d = new Date()) {
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/** Motif court, sur une ligne, sans rien de long. */
export function motifCourt(m) {
  return String(m || "").replace(/\s+/g, " ").trim().slice(0, 120);
}

// ---------- Réseau ----------

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

/** Suit les redirections à la main. Erreur réseau → { erreur }. */
export async function parcourir(url, { fetchImpl = fetch, maxSauts = MAX_SAUTS, lireCorps = true } = {}) {
  const vues = [url];
  let courante = url;
  for (;;) {
    let rep;
    try {
      rep = await fetchImpl(courante, {
        redirect: "manual",
        headers: { "user-agent": UA },
        signal: AbortSignal.timeout(DELAI_MS),
      });
    } catch (e) {
      const nom = e?.name === "TimeoutError" ? `délai de ${DELAI_MS / 1000} s dépassé` : `erreur réseau (${e?.cause?.code || e?.name || "inconnue"})`;
      return { erreur: nom, reseau: true };
    }
    if (rep.status >= 300 && rep.status < 400 && rep.headers.get("location")) {
      await rep.body?.cancel().catch(() => {});
      const suivante = new URL(rep.headers.get("location"), courante).href;
      const boucle = detecterBoucle(vues, suivante, maxSauts);
      if (boucle) return { erreur: boucle };
      vues.push(suivante);
      courante = suivante;
      continue;
    }
    const corps = lireCorps ? await rep.text().catch(() => "") : (await rep.body?.cancel().catch(() => {}), "");
    return { statut: rep.status, sauts: vues.length - 1, urlFinale: courante, corps };
  }
}

async function unEssai(controle, env, fetchImpl) {
  if (controle.type === "battement") {
    const valeur = await lireBattement(env, fetchImpl);
    return evaluerBattement(valeur);
  }
  const res = await parcourir(controle.url, { fetchImpl });
  const analyse = analyserReponse(controle, res);
  if (analyse.ok && analyse.script) {
    const urlScript = new URL(analyse.script, res.urlFinale).href;
    const rs = await parcourir(urlScript, { fetchImpl, lireCorps: false });
    if (rs.erreur) return { ok: false, motif: `script Lovable : ${rs.erreur}`, reseau: rs.reseau };
    if (rs.statut !== 200) return { ok: false, motif: `script Lovable HTTP ${rs.statut}` };
  }
  return { ...analyse, reseau: res.reseau };
}

/** Exécute un contrôle ; une erreur réseau/délai est retentée une fois après 10 s. */
export async function executerControle(controle, env = process.env, { fetchImpl = fetch, pause = PAUSE_REESSAI_MS } = {}) {
  const debut = Date.now();
  let r = await unEssai(controle, env, fetchImpl);
  if (!r.ok && r.reseau) {
    await attendre(pause);
    r = await unEssai(controle, env, fetchImpl);
    if (!r.ok) r.motif = `${r.motif} (après 1 nouvel essai)`;
  }
  return { id: controle.id, url: controle.url, ok: r.ok, motif: motifCourt(r.motif), dureeMs: Date.now() - debut };
}

// ---------- Battement : API d'abord, sinon valeur injectée au démarrage ----------

let sourceBattement = "";
async function lireBattement(env, fetchImpl = fetch) {
  const api = await lireVariableApi(env, "BATTEMENT_VPS", fetchImpl);
  if (api.lisible) {
    sourceBattement = "API (valeur au moment du contrôle)";
    return api.valeur;
  }
  sourceBattement = `contexte vars (valeur au démarrage du run ; API : HTTP ${api.statut})`;
  return env.BATTEMENT_VPS_CTX || "";
}

async function lireVariableApi(env, nom, fetchImpl = fetch) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) return { lisible: false, statut: "sans jeton" };
  try {
    const rep = await fetchImpl(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/variables/${nom}`, {
      headers: enTetesGithub(env),
      signal: AbortSignal.timeout(DELAI_MS),
    });
    if (rep.status === 200) return { lisible: true, valeur: (await rep.json()).value };
    // 404 avec le jeton = variable absente OU accès refusé ; on se rabat sur le contexte
    return { lisible: false, statut: rep.status };
  } catch {
    return { lisible: false, statut: "erreur réseau" };
  }
}

// ---------- GitHub (issues) ----------

function enTetesGithub(env) {
  return {
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "myro-veille",
  };
}

async function gh(env, methode, chemin, corps) {
  const rep = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}${chemin}`, {
    method: methode,
    headers: { ...enTetesGithub(env), ...(corps ? { "content-type": "application/json" } : {}) },
    body: corps ? JSON.stringify(corps) : undefined,
    signal: AbortSignal.timeout(DELAI_MS),
  });
  if (!rep.ok && !(methode === "POST" && chemin === "/labels" && rep.status === 422)) {
    throw new Error(`GitHub ${methode} ${chemin} → HTTP ${rep.status}`);
  }
  return rep.status === 204 ? null : rep.json().catch(() => null);
}

async function assurerLabel(env) {
  await gh(env, "POST", "/labels", { name: LABEL, color: "d73a4a", description: "Panne détectée par la veille" });
}

async function issuesOuvertes(env) {
  const liste = await gh(env, "GET", `/issues?state=open&labels=${LABEL}&per_page=100`);
  const parId = new Map();
  for (const i of liste || []) {
    if (i.pull_request) continue;
    const id = idDepuisTitre(i.title);
    if (id && !parId.has(id)) parId.set(id, i);
  }
  return parId;
}

function lienRun(env) {
  return env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL || "https://github.com"}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    : "(hors GitHub Actions)";
}

function corpsIssue(r, env, debut, derniere) {
  return [
    `**Contrôle** : \`${r.id}\``,
    `**URL** : ${r.url}`,
    `**Motif** : ${r.motif}`,
    `**Début de panne** : ${debut}`,
    `**Dernière vue en panne** : ${derniere}`,
    `**Run** : ${lienRun(env)}`,
  ].join("\n\n");
}

// ---------- E-mail (Resend) ----------

async function envoyerEmail(env, sujet, texte) {
  if (!env.RESEND_API_KEY || !env.ALERTE_EMAIL) {
    console.log(`E-mail non envoyé (clé ou destinataire absent) : ${sujet}`);
    return null;
  }
  try {
    const rep = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: "Veille Myro <veille@corsetticonsulting.com>", to: [env.ALERTE_EMAIL], subject: sujet, text: texte }),
      signal: AbortSignal.timeout(DELAI_MS),
    });
    const json = await rep.json().catch(() => ({}));
    if (!rep.ok) {
      console.log(`Resend en échec (HTTP ${rep.status}) pour « ${sujet} » : ${motifCourt(json?.message)}`);
      return null;
    }
    console.log(`Resend OK — id ${json.id} — « ${sujet} »`);
    return json.id;
  } catch (e) {
    console.log(`Resend injoignable pour « ${sujet} » : ${e?.name}`);
    return null;
  }
}

// ---------- Programme principal ----------

export async function main(env = process.env) {
  const controles = construireControles(env);
  const resultats = await Promise.all(controles.map((c) => executerControle(c, env)));
  const maintenant = new Date();
  let nouvellesPannes = 0;
  const actions = [];

  const avecGithub = Boolean(env.GITHUB_TOKEN && env.GITHUB_REPOSITORY);
  let ouvertes = new Map();
  if (avecGithub) {
    await assurerLabel(env);
    ouvertes = await issuesOuvertes(env);
  }

  for (const r of resultats) {
    const issue = ouvertes.get(r.id);
    const action = deciderAction(r.ok, Boolean(issue));
    r.action = action;
    if (!avecGithub) {
      if (action === "ouvrir") nouvellesPannes++;
      continue;
    }
    if (action === "ouvrir") {
      nouvellesPannes++;
      const h = heureUtc(maintenant);
      const cree = await gh(env, "POST", "/issues", {
        title: `[${r.id}] EN PANNE — ${r.motif}`,
        body: corpsIssue(r, env, h, h),
        labels: [LABEL],
      });
      actions.push(`Issue #${cree.number} ouverte pour ${r.id}`);
      await envoyerEmail(env, `🔴 PANNE ${r.id} — ${r.motif}`,
        `Panne détectée à ${h}.\nContrôle : ${r.id}\nURL : ${r.url}\nMotif : ${r.motif}\n\nIssue : ${cree.html_url}\nRun : ${lienRun(env)}\n`);
    } else if (action === "toujours") {
      // Mise à jour silencieuse du corps (pas de commentaire → pas de notification)
      const debut = /\*\*Début de panne\*\* : ([^\n]+)/.exec(issue.body || "")?.[1] || heureUtc(new Date(issue.created_at));
      await gh(env, "PATCH", `/issues/${issue.number}`, { body: corpsIssue(r, env, debut, heureUtc(maintenant)) });
      actions.push(`Issue #${issue.number} (${r.id}) toujours en panne — pas de nouvelle alerte`);
    } else if (action === "retablir") {
      const duree = dureeMinutes(issue.created_at, maintenant);
      const h = heureUtc(maintenant);
      await gh(env, "POST", `/issues/${issue.number}/comments`, { body: `Rétabli à ${h} (durée ~${duree} min)` });
      await gh(env, "PATCH", `/issues/${issue.number}`, { state: "closed", state_reason: "completed" });
      actions.push(`Issue #${issue.number} (${r.id}) rétablie et fermée`);
      await envoyerEmail(env, `✅ RÉTABLI ${r.id} (durée ${duree} min)`,
        `Rétabli à ${h} (durée ~${duree} min).\nContrôle : ${r.id}\nURL : ${r.url}\n\nIssue : ${issue.html_url}\n`);
    }
  }

  // Journal et résumé
  for (const r of resultats) console.log(`${r.ok ? "OK   " : "PANNE"} ${r.id.padEnd(20)} ${String(r.dureeMs).padStart(6)} ms  ${r.motif}`);
  for (const a of actions) console.log(a);
  if (sourceBattement) console.log(`Battement lu via : ${sourceBattement}`);
  if (!controles.some((c) => c.type === "battement") && avecGithub) {
    const t = await lireVariableApi(env, "BATTEMENT_VPS");
    console.log(`Diagnostic : lecture API des variables avec GITHUB_TOKEN → ${t.lisible ? "possible" : `impossible (HTTP ${t.statut})`}`);
  }

  if (env.GITHUB_STEP_SUMMARY) {
    const lignes = [
      `### Veille Myro — ${heureUtc(maintenant)}`,
      "",
      "| id | statut | durée (ms) | motif |",
      "|---|---|---:|---|",
      ...resultats.map((r) => `| \`${r.id}\` | ${r.ok ? "✅ OK" : r.action === "ouvrir" ? "🔴 NOUVELLE PANNE" : "🔴 panne (déjà signalée)"} | ${r.dureeMs} | ${r.motif.replace(/\|/g, "\\|")} |`),
      "",
      ...(actions.length ? actions.map((a) => `- ${a}`) : ["- Aucune action sur les incidents"]),
      ...(sourceBattement ? [`- Battement lu via : ${sourceBattement}`] : ["- `battement-vps` désactivé (BATTEMENT_ACTIF ≠ 1)"]),
      "",
    ];
    appendFileSync(env.GITHUB_STEP_SUMMARY, lignes.join("\n"));
  }

  if (nouvellesPannes > 0) {
    console.log(`${nouvellesPannes} nouvelle(s) panne(s) : le run échoue volontairement.`);
    process.exitCode = 1;
  }
  return { resultats, nouvellesPannes };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((e) => {
    console.error(`Erreur de la veille : ${motifCourt(e?.message)}`);
    process.exitCode = 1;
  });
}
