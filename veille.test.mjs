// Tests des fonctions pures : node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deciderAction, analyserReponse, detecterBoucle, evaluerBattement, idDepuisTitre,
  extraireScriptLovable, construireControles, parcourir, executerControle, dureeMinutes,
} from "./veille.mjs";

test("décision d'état : une alerte par incident, puis rétabli", () => {
  assert.equal(deciderAction(false, false), "ouvrir");
  assert.equal(deciderAction(false, true), "toujours");
  assert.equal(deciderAction(true, true), "retablir");
  assert.equal(deciderAction(true, false), "rien");
});

test("id lu depuis le titre d'issue", () => {
  assert.equal(idDepuisTitre("[url-test] EN PANNE — HTTP 503"), "url-test");
  assert.equal(idDepuisTitre("Autre chose"), null);
});

const freecourse = construireControles({}).find((c) => c.id === "corsetti-freecourse");
const business = construireControles({}).find((c) => c.id === "nabil-business");
const kpi = construireControles({}).find((c) => c.id === "myro-kpi");
const corpsFc = '<script src="/api/m/tag/nicolas/formation.js"></script><script src="/evergreen/comportements.js"></script>';

test("analyse : page conforme", () => {
  assert.deepEqual(analyserReponse(freecourse, { statut: 200, sauts: 0, urlFinale: freecourse.url, corps: corpsFc }), { ok: true, motif: "" });
});

test("analyse : statut, redirections, marqueurs, erreur", () => {
  assert.match(analyserReponse(freecourse, { statut: 503, sauts: 0, urlFinale: freecourse.url, corps: "" }).motif, /HTTP 503/);
  assert.match(analyserReponse(freecourse, { statut: 200, sauts: 2, urlFinale: freecourse.url, corps: corpsFc }).motif, /2 redirections/);
  assert.match(analyserReponse(freecourse, { statut: 200, sauts: 0, urlFinale: freecourse.url, corps: "<html>" }).motif, /marqueur absent : \/api\/m\/tag\/nicolas/);
  assert.equal(analyserReponse(freecourse, { erreur: "boucle de redirection" }).motif, "boucle de redirection");
});

test("analyse : business extrait le script Lovable", () => {
  const corps = '<div id="root"></div><script type="module" crossorigin src="/assets/index-BMlp8CsZ.js"></script>';
  const r = analyserReponse(business, { statut: 200, sauts: 0, urlFinale: business.url, corps });
  assert.equal(r.ok, true);
  assert.equal(r.script, "/assets/index-BMlp8CsZ.js");
  assert.match(analyserReponse(business, { statut: 200, sauts: 0, urlFinale: business.url, corps: '<div id="root"></div>' }).motif, /script/);
  assert.equal(extraireScriptLovable("rien"), null);
});

test("analyse : myro-kpi doit finir sur /login", () => {
  const ok = analyserReponse(kpi, { statut: 200, sauts: 1, urlFinale: "https://myro-kpi.vercel.app/login", corps: "<title>Connexion · Myro</title>" });
  assert.equal(ok.ok, true);
  const ko = analyserReponse(kpi, { statut: 200, sauts: 0, urlFinale: "https://myro-kpi.vercel.app/", corps: "Connexion · Myro" });
  assert.match(ko.motif, /au lieu de \/login/);
});

test("boucle de redirection : URL déjà vue ou trop de sauts", () => {
  assert.match(detecterBoucle(["https://a/", "https://a/b"], "https://a/"), /boucle/);
  assert.equal(detecterBoucle(["https://a/"], "https://a/b"), null);
  const six = ["1", "2", "3", "4", "5", "6"].map((n) => `https://a/${n}`);
  assert.match(detecterBoucle(six, "https://a/7"), /plus de 5 redirections/);
  assert.equal(detecterBoucle(six.slice(0, 5), "https://a/7"), null); // 5e saut accepté
});

function faux(routes) {
  return async (url) => {
    const r = routes[url];
    if (!r) throw new TypeError("fetch failed");
    return new Response(r.corps ?? "", { status: r.statut, headers: r.location ? { location: r.location } : {} });
  };
}

test("parcours : redirections suivies à la main, boucle détectée", async () => {
  const f = faux({
    "https://x.test/": { statut: 307, location: "/login" },
    "https://x.test/login": { statut: 200, corps: "Connexion · Myro" },
    "https://b.test/a": { statut: 302, location: "https://b.test/b" },
    "https://b.test/b": { statut: 302, location: "https://b.test/a" },
  });
  const r = await parcourir("https://x.test/", { fetchImpl: f });
  assert.equal(r.statut, 200);
  assert.equal(r.sauts, 1);
  assert.equal(r.urlFinale, "https://x.test/login");
  assert.match((await parcourir("https://b.test/a", { fetchImpl: f })).erreur, /boucle/);
});

test("erreur réseau retentée une fois", async () => {
  let appels = 0;
  const f = async () => { appels++; if (appels === 1) throw new TypeError("fetch failed"); return new Response("", { status: 200 }); };
  const r = await executerControle({ id: "t", url: "https://t.test/", marqueurs: [] }, {}, { fetchImpl: f, pause: 1 });
  assert.equal(r.ok, true);
  assert.equal(appels, 2);
  const r2 = await executerControle({ id: "t", url: "https://t.test/", marqueurs: [] }, {}, { fetchImpl: faux({}), pause: 1 });
  assert.equal(r2.ok, false);
  assert.match(r2.motif, /après 1 nouvel essai/);
});

test("âge et état du battement", () => {
  const now = new Date("2026-09-29T12:00:00Z");
  assert.equal(evaluerBattement("2026-09-29T11:55:00Z ok", now).ok, true);
  assert.match(evaluerBattement("2026-09-29T11:40:00Z ok", now).motif, /vieux de 20 min/);
  assert.match(evaluerBattement("", now).motif, /absent/);
  assert.match(evaluerBattement("n'importe quoi", now).motif, /illisible/);
  assert.match(evaluerBattement("2026-09-29T11:58:00Z bof", now).motif, /illisible/);
  assert.equal(evaluerBattement("2026-09-29T11:58:00Z erreur:disque plein", now).motif, "VPS en erreur : disque plein");
  assert.equal(evaluerBattement("2026-09-29T11:45:00Z ok", now).ok, true); // 15 min pile : accepté
});

test("contrôles optionnels selon les variables", () => {
  const base = construireControles({});
  assert.equal(base.length, 7);
  assert.equal(construireControles({ BATTEMENT_ACTIF: "0" }).length, 7);
  const tous = construireControles({ BATTEMENT_ACTIF: "1", URL_TEST_PANNE: "https://httpbin.org/status/503" });
  assert.deepEqual(tous.slice(7).map((c) => c.id), ["battement-vps", "url-test"]);
  assert.equal(new Set(tous.map((c) => c.id)).size, tous.length);
});

test("durée en minutes", () => {
  assert.equal(dureeMinutes("2026-09-29T11:30:00Z", new Date("2026-09-29T12:00:00Z")), 30);
});
