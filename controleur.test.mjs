// Tests du contrôleur VPS (node --test) — décision pure et passage complet sur un faux réseau.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CONTROLEUR_ETAT = mkdtempSync(path.join(os.tmpdir(), "controleur-"));
const { decider, controlesDuControleur, passage } = await import("./controleur.mjs");

const KO = { ok: false, motif: "HTTP 503" };
const OK = { ok: true, motif: "" };

test("un seul échec : pas d'alerte", () => {
  assert.equal(decider(undefined, KO).action, null);
});
test("deux échecs consécutifs : alerte, une seule", () => {
  const a = decider(undefined, KO);
  const b = decider(a.etat, KO);
  assert.equal(b.action, "alerte");
  const c = decider(b.etat, KO);
  assert.equal(c.action, null, "pas de rafale pendant l'incident");
});
test("retour à la normale : un e-mail, puis plus rien", () => {
  const b = decider(decider(undefined, KO).etat, KO);
  const r = decider(b.etat, OK);
  assert.equal(r.action, "retour");
  assert.equal(decider(r.etat, OK).action, null);
});
test("un échec isolé entre deux succès : rien", () => {
  const a = decider(undefined, KO);
  const b = decider(a.etat, OK);
  assert.equal(b.action, null);
  assert.equal(decider(b.etat, KO).action, null);
});
test("la liste : 2 routes de santé, 4 pages clientes, la connexion kpi", () => {
  const ids = controlesDuControleur().map((c) => c.id).sort();
  assert.deepEqual(ids, ["corsetti-freecourse", "corsetti-webinaire", "kpi-connexion", "nabil-freecourse", "nabil-webinaire", "sante-funnel", "sante-kpi"]);
  assert.equal(controlesDuControleur("https://exemple.test/x").at(-1).id, "test-panne");
});

test("passage : panne confirmée 60 s plus tard → un e-mail ; retour → un e-mail ; battement écrit", async () => {
  let enPanne = true;
  const mails = [];
  const fetchImpl = async (url, init) => {
    if (String(url).includes("api.resend.com")) {
      mails.push(JSON.parse(init.body).subject);
      return new Response(JSON.stringify({ id: "m" }), { status: 200 });
    }
    if (String(url).includes("/api/sante/base") && String(url).includes("kpi")) {
      return new Response(enPanne ? '{"ok":false}' : '{"ok":true}', { status: enPanne ? 503 : 200 });
    }
    if (String(url).includes("/api/sante/base")) return new Response('{"ok":true}', { status: 200 });
    if (String(url).endsWith("myro-kpi.vercel.app/")) return new Response("", { status: 307, headers: { location: "/login" } });
    if (String(url).includes("/login")) return new Response("<title>Connexion · Myro</title>", { status: 200 });
    const cle = String(url).includes("nabil") ? "nabil" : "nicolas";
    const page = String(url).includes("webinaire") ? "webinaire" : "formation";
    return new Response(`/api/m/tag/${cle}/${page}.js /evergreen/comportements.js /wb/v2/comportements.js`, { status: 200 });
  };
  const env = { RESEND_API_KEY: "re_test", ALERTE_EMAIL: "a@b.c" };
  const p1 = await passage({ env, fetchImpl, pause: 1 });
  assert.deepEqual(mails, ["🔴 Myro EN PANNE — sante-kpi"]);
  assert.equal(p1.etats["sante-kpi"].echecs, 2);
  await passage({ env, fetchImpl, pause: 1 });
  assert.equal(mails.length, 1, "pas de second e-mail pendant l'incident");
  enPanne = false;
  await passage({ env, fetchImpl, pause: 1 });
  assert.deepEqual(mails, ["🔴 Myro EN PANNE — sante-kpi", "✅ Myro rétabli — sante-kpi"]);
  const battement = readFileSync(path.join(process.env.CONTROLEUR_ETAT, "battement"), "utf8").trim();
  assert.ok(Date.now() - Date.parse(battement) < 60_000);
});
