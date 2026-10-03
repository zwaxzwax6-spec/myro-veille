// Contrôleur continu Myro — VPS, toutes les 5 min, HORS de Vercel (03/10/2026).
// Lancé par systemd (`myro-controleur.timer`) ; l'état des incidents est un fichier local.
//
// Contrôles : les deux routes de santé (elles interrogent vraiment la base), /freecourse et
// /webinaire des deux domaines clients, la page de connexion de myro-kpi.
// Règle : un contrôle en échec est refait 60 s plus tard dans le même passage ; DEUX échecs
// consécutifs ouvrent l'incident et envoient UN e-mail. Le retour à la normale envoie UN e-mail.
// Rien entre les deux (une alerte par incident, pas de rafale).
// Le contrôleur se surveille lui-même : il écrit un battement à chaque passage ; le rapport de
// 8 h (myro-funnel) le lit et passe au rouge s'il a plus de 15 min.
// RIEN de sensible ne sort d'ici : statut, URL publique, motif court.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { construireControles, executerControle, heureUtc, MAX_SAUTS } from "./veille.mjs";

export const ETAT_DIR = process.env.CONTROLEUR_ETAT || path.join(os.homedir(), ".local/state/myro-controleur");
export const PAUSE_CONFIRMATION_MS = 60_000;
export const ECHECS_POUR_ALERTE = 2;

/** L'URL montrée dans un e-mail ou le journal : sans paramètres (un contournement de protection en est un). */
export function urlAffichee(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "(url illisible)";
  }
}

const SANTE = (id, url) => ({ id, url, maxRedirections: 0, marqueurs: ['"ok":true'] });

/** La liste fixe des contrôles, plus une URL de test facultative (simulation de panne). */
export function controlesDuControleur(urlTest = "") {
  const veille = construireControles({});
  const garder = new Set(["corsetti-freecourse", "corsetti-webinaire", "nabil-freecourse", "nabil-webinaire", "myro-kpi"]);
  const liste = [
    SANTE("sante-funnel", "https://myro-funnel-nicolas.vercel.app/api/sante/base"),
    SANTE("sante-kpi", "https://myro-kpi.vercel.app/api/sante/base"),
    ...veille.filter((c) => garder.has(c.id)).map((c) => (c.id === "myro-kpi" ? { ...c, id: "kpi-connexion" } : c)),
  ];
  if (urlTest.trim()) liste.push({ id: "test-panne", url: urlTest.trim(), maxRedirections: MAX_SAUTS, marqueurs: [] });
  return liste;
}

/**
 * La décision, pure : l'état d'un contrôle + le résultat → le nouvel état et l'action.
 * état = { echecs, incident: null | { depuis, motif } }
 */
export function decider(etat, resultat, maintenant = new Date()) {
  const e = { echecs: etat?.echecs ?? 0, incident: etat?.incident ?? null };
  if (resultat.ok) {
    if (e.incident) return { etat: { echecs: 0, incident: null }, action: "retour", incident: e.incident };
    return { etat: { echecs: 0, incident: null }, action: null };
  }
  const echecs = e.echecs + 1;
  if (!e.incident && echecs >= ECHECS_POUR_ALERTE) {
    const incident = { depuis: maintenant.toISOString(), motif: resultat.motif };
    return { etat: { echecs, incident }, action: "alerte", incident };
  }
  return { etat: { echecs, incident: e.incident }, action: null };
}

function lireJson(f, defaut) {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return defaut;
  }
}
function ecrireJson(f, v) {
  writeFileSync(`${f}.tmp`, JSON.stringify(v, null, 2));
  renameSync(`${f}.tmp`, f);
}

export function lireEnv(fichier) {
  const env = {};
  if (!existsSync(fichier)) return env;
  for (const l of readFileSync(fichier, "utf8").split("\n")) {
    const m = /^\s*([A-Z_]+)=(.*)$/.exec(l);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

async function envoyer(env, sujet, texte, idempotence, fetchImpl = fetch) {
  if (!env.RESEND_API_KEY) return { ok: false, motif: "pas de clé Resend" };
  try {
    const r = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json", "idempotency-key": idempotence },
      body: JSON.stringify({ from: "Veille Myro <veille@corsetticonsulting.com>", to: [env.ALERTE_EMAIL], subject: sujet, text: texte }),
      signal: AbortSignal.timeout(20_000),
    });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, id: j.id } : { ok: false, motif: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, motif: e?.name || "erreur" };
  }
}

export async function passage({ env, fetchImpl = fetch, pause = PAUSE_CONFIRMATION_MS, maintenant = () => new Date() } = {}) {
  mkdirSync(ETAT_DIR, { recursive: true });
  const fEtat = path.join(ETAT_DIR, "etat.json");
  const fJournal = path.join(ETAT_DIR, "journal.log");
  const etats = lireJson(fEtat, {});
  const urlTest = existsSync(path.join(ETAT_DIR, "url-test")) ? readFileSync(path.join(ETAT_DIR, "url-test"), "utf8") : "";
  const controles = controlesDuControleur(urlTest);

  let resultats = await Promise.all(controles.map((c) => executerControle(c, env, { fetchImpl })));
  const aConfirmer = resultats.filter((r) => !r.ok && !etats[r.id]?.incident).map((r) => r.id);
  // Un échec sans incident ouvert est refait 60 s plus tard ; c'est la confirmation qui décide.
  const decisions = [];
  for (const r of resultats) {
    if (aConfirmer.includes(r.id)) {
      /* À confirmer : on compte l'échec, la décision se prend sur la confirmation. */
      etats[r.id] = { echecs: (etats[r.id]?.echecs ?? 0) + 1, incident: null };
      continue;
    }
    const d = decider(etats[r.id], r, maintenant());
    etats[r.id] = d.etat;
    decisions.push({ r, d });
  }
  if (aConfirmer.length) {
    await new Promise((ok) => setTimeout(ok, pause));
    const refaits = await Promise.all(controles.filter((c) => aConfirmer.includes(c.id)).map((c) => executerControle(c, env, { fetchImpl })));
    for (const r of refaits) {
      const d = decider(etats[r.id], r, maintenant());
      etats[r.id] = d.etat;
      decisions.push({ r, d });
    }
    resultats = resultats.map((r) => refaits.find((x) => x.id === r.id) ?? r);
  }
  for (const id of Object.keys(etats)) if (!controles.some((c) => c.id === id)) delete etats[id];

  const envois = [];
  for (const { r, d } of decisions) {
    if (!d.action) continue;
    const quand = heureUtc(maintenant());
    const sujet = d.action === "alerte" ? `🔴 Myro EN PANNE — ${r.id}` : `✅ Myro rétabli — ${r.id}`;
    const texte =
      d.action === "alerte"
        ? `${urlAffichee(r.url)}\nMotif : ${r.motif}\nDeux échecs consécutifs (contrôle du VPS, toutes les 5 min), constaté à ${quand}.\nUn seul e-mail par incident ; un second partira au retour à la normale.\nQue faire : docs/INCIDENTS.md (dépôt myro-funnel).`
        : `${urlAffichee(r.url)}\nDe nouveau en ordre à ${quand} (panne ouverte à ${heureUtc(new Date(d.incident.depuis))}).`;
    const e = await envoyer(env, sujet, texte, `myro-controleur-${r.id}-${d.incident.depuis}-${d.action}`, fetchImpl);
    envois.push({ id: r.id, action: d.action, ...e });
    /* E-mail non parti : l'incident n'est PAS tenu pour signalé (revue du 03/10).
       Panne : on ne l'ouvre pas — le passage suivant, toujours en échec, retente
       l'alerte. Retour : on le garde ouvert — le passage suivant retente le retour. */
    if (!e.ok) etats[r.id] = d.action === "alerte" ? { ...d.etat, incident: null } : { echecs: 0, incident: d.incident };
  }

  ecrireJson(fEtat, etats);
  const a = maintenant().toISOString();
  writeFileSync(path.join(ETAT_DIR, "battement"), `${a}\n`);
  const ligne = `${a} ${resultats.map((r) => `${r.id}=${r.ok ? "ok" : `KO(${r.motif})`}`).join(" ")}${envois.length ? ` | e-mails : ${JSON.stringify(envois)}` : ""}\n`;
  writeFileSync(fJournal, ligne, { flag: "a" });
  process.stdout.write(ligne);
  return { resultats, envois, etats };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const env = lireEnv(process.env.CONTROLEUR_ENV || path.join(os.homedir(), "projects/myro-funnel/.env"));
  env.ALERTE_EMAIL ||= "mohamed.khelifaa9@gmail.com";
  passage({ env }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
