/* Vision : interface unique (iPhone en PWA, PC via Flask sur 127.0.0.1).
   Mode PC : jeton machine servi par /local/config (jamais publié). Mode iPhone : connexion Supabase par lien magique.
   Les actions qui demandent Claude/Gmail/LinkedIn sont mises en file dans Supabase et traitées par le PC. */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString("fr-FR", { day: "2-digit", month: "short" }) : "");
const fmtDT = (d) => (d ? new Date(d).toLocaleString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
let sb, MODE = "iphone", TAB = "home", timer = null;
const ST = { offSeg: "offres", fOff: { q: "", km: 999, statut: "ouvertes", tri: "score" }, fEnt: { q: "", km: 999, statut: "retenue", contact: "tous" }, mailSeg: "tous" };

const REP = { sans_reponse: ["Sans réponse", ""], refus: ["Refus", "bad"], entretien: ["Entretien", "ok"], demande_info: ["Demande d'info", "warn"], auto: ["Réponse auto", ""], a_repondre: ["À répondre", "acc"] };
const CST = { a_generer: ["Génération en attente du PC", "warn"], brouillon: ["Brouillon", "acc"], a_envoyer: ["En file d'envoi", "warn"], envoyee: ["Envoyé", "ok"], erreur: ["Erreur", "bad"], annulee: ["Annulé", ""] };

async function boot() {
  const C = window.VISION;
  try {
    const r = await fetch("/local/config", { cache: "no-store" });
    if (r.ok) { const j = await r.json(); if (j.mode === "pc" && j.machine_token) { MODE = "pc"; sb = supabase.createClient(C.supabaseUrl, C.supabaseKey, { global: { headers: { "x-machine-token": j.machine_token } }, auth: { persistSession: false } }); } }
  } catch (e) { /* pas de serveur local : mode iPhone */ }
  if (!sb) sb = supabase.createClient(C.supabaseUrl, C.supabaseKey, { auth: { persistSession: true, detectSessionInUrl: true, flowType: "implicit" } });
  $("#mode").textContent = MODE === "pc" ? "PC" : "iPhone";
  if (MODE !== "pc") {
    const { data } = await sb.auth.getSession();
    if (!data.session) return loginView();
    sb.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_OUT") loginView(); });
  }
  if ("serviceWorker" in navigator && MODE !== "pc") navigator.serviceWorker.register("sw.js").catch(() => {});
  $("#tabs").hidden = false;
  document.querySelectorAll("#tabs button").forEach((b) => (b.onclick = () => go(b.dataset.tab)));
  go(location.hash.slice(1) || "home");
  pcHeartbeat();
}

function loginView() {
  $("#tabs").hidden = true;
  $("#view").innerHTML = `<div class="card"><h2>Connexion</h2><p class="muted small">Un lien de connexion est envoyé à ton adresse. Ouvre-le sur cet iPhone (de préférence depuis l'appli installée).</p>
    <label>Adresse e-mail</label><input id="em" type="email" autocomplete="email" inputmode="email" placeholder="ton adresse">
    <p><button class="primary wide" id="send">Recevoir le lien</button></p><p id="msg" class="small muted"></p></div>
    <div class="card"><h3>Appli installée sur l'écran d'accueil ?</h3><p class="small muted">iOS ouvre le lien du mail dans Safari, pas dans l'appli. Dans le mail, <b>appuie longuement sur le bouton de connexion → Copier le lien</b>, reviens ici et colle-le.</p>
    <input id="pasted" placeholder="Colle ici le lien copié" autocapitalize="off" autocorrect="off">
    <p><button class="wide" id="paste">Me connecter avec ce lien</button></p><p id="msg2" class="small muted"></p></div>`;
  $("#paste").onclick = async () => {
    try {
      const u = new URL($("#pasted").value.trim());
      const token_hash = u.searchParams.get("token"), type = u.searchParams.get("type");
      if (!token_hash || !type) throw new Error("lien non reconnu");
      const { error } = await sb.auth.verifyOtp({ token_hash, type });
      if (error) throw error;
      location.reload();
    } catch (e) { $("#msg2").textContent = "Échec : " + (e.message || e) + " (le lien expire vite : redemande-en un)"; }
  };
  $("#send").onclick = async () => {
    const email = $("#em").value.trim().toLowerCase();
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname, shouldCreateUser: true } });
    $("#msg").textContent = error ? "Erreur : " + error.message : "Lien envoyé. Ouvre le mail sur cet appareil.";
  };
}

function go(tab) {
  TAB = tab; location.hash = tab;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  clearInterval(timer);
  ({ home, veille, offres, mails, drafts }[tab] || home)();
}

async function q(p) { const { data, error } = await p; if (error) { toast("Erreur : " + error.message); throw error; } return data; }
function toast(t) { const n = document.createElement("div"); n.className = "note"; n.style.cssText = "position:fixed;left:16px;right:16px;bottom:90px;z-index:9"; n.textContent = t; document.body.appendChild(n); setTimeout(() => n.remove(), 3500); }

/* ---------------------------------------------------------------- état du PC */
async function pcHeartbeat() {
  // le PC est « allumé » s'il a traité quelque chose récemment ; en mode PC, on lit son état local
  if (MODE === "pc") {
    try { const s = await (await fetch("/local/status")).json(); $("#pcstate").textContent = `PC : ${s.etat}${s.prochain_envoi ? " · prochain envoi " + s.prochain_envoi : ""}`; } catch (e) {}
  } else {
    const wait = await q(sb.from("candidatures").select("id", { count: "exact", head: true }).in("statut", ["a_generer", "a_envoyer"]));
    const d = await q(sb.from("demandes_veille").select("id").eq("statut", "en_attente").eq("attend_pc", true));
    const n = (wait?.length ?? 0);
    $("#pcstate").textContent = "Les actions Claude/Gmail partent au prochain démarrage du PC";
  }
  setTimeout(pcHeartbeat, 15000);
}

/* ---------------------------------------------------------------- 1. tableau de bord */
async function home() {
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const [nouv, env, rep, att, relances, last] = await Promise.all([
    sb.from("offres").select("id", { count: "exact", head: true }).eq("statut", "nouvelle").gte("detecte_le", since),
    sb.from("candidatures").select("id", { count: "exact", head: true }).eq("statut", "envoyee").eq("est_relance", false),
    sb.from("candidatures").select("id", { count: "exact", head: true }).in("reponse_statut", ["entretien", "demande_info", "a_repondre"]),
    sb.from("candidatures").select("id,statut", { count: "exact" }).in("statut", ["a_generer", "a_envoyer"]),
    sb.from("candidatures").select("id", { count: "exact", head: true }).eq("est_relance", true).eq("statut", "brouillon"),
    sb.from("demandes_veille").select("*").eq("type", "veille").order("created_at", { ascending: false }).limit(1),
  ]);
  const top = await q(sb.from("offres").select("id,titre,entreprise,ville,km,score,score_raison").eq("statut", "nouvelle").order("score", { ascending: false }).limit(5));
  const topE = await q(sb.from("entreprises").select("id,nom,ville,km,score,score_raison").eq("statut", "retenue").eq("valide", false).order("score", { ascending: false }).limit(5));
  const l = last.data?.[0];
  const waitN = att.count || 0;
  $("#view").innerHTML = `
    <div class="grid">
      <div class="kpi tap" onclick="go('offres')"><b>${nouv.count ?? 0}</b><span>nouvelles offres (7 j)</span></div>
      <div class="kpi tap" onclick="go('mails')"><b>${env.count ?? 0}</b><span>mails envoyés</span></div>
      <div class="kpi tap" onclick="ST.mailSeg='a_traiter';go('mails')"><b>${rep.count ?? 0}</b><span>réponses à traiter</span></div>
      <div class="kpi tap" onclick="go('drafts')"><b>${relances.count ?? 0}</b><span>relances proposées</span></div>
    </div>
    ${waitN ? `<div class="note warn">${waitN} action(s) en attente du PC (génération ou envoi). ${MODE === "pc" ? "Le PC les traite." : "Elles partiront dès que le PC sera allumé."}</div>` : ""}
    <div class="card"><div class="row between"><b>Dernière veille</b>${l ? `<span class="pill ${l.statut === "terminee" ? "ok" : l.statut === "erreur" ? "bad" : "warn"}">${esc(l.statut)}</span>` : ""}</div>
      <div class="small muted">${l ? `${fmtDT(l.created_at)} · ${esc(l.origine)}${l.resultat ? ` · ${l.resultat.nouvelles ?? 0} nouvelles, ${l.resultat.doublons ?? 0} doublons, ${l.resultat.erreurs ?? 0} erreurs` : ""}` : "aucune"}</div>
      <p><button class="primary wide" onclick="go('veille')">Lancer la veille</button></p></div>
    <h3>Meilleures offres</h3>${top.map(offerCard).join("") || '<p class="muted small">Aucune nouvelle offre.</p>'}
    <h3>Entreprises à contacter</h3>${topE.map(entCard).join("") || '<p class="muted small">—</p>'}`;
}

/* ---------------------------------------------------------------- 2. veille */
async function veille() {
  const rows = await q(sb.from("demandes_veille").select("*").eq("type", "veille").order("created_at", { ascending: false }).limit(8));
  const cur = rows.find((r) => ["en_attente", "en_cours"].includes(r.statut) && !r.attend_pc);
  const pcWait = rows.find((r) => r.attend_pc && r.statut === "en_attente");
  $("#view").innerHTML = `<h2>Veille</h2>
    <div class="card"><p class="small muted">${MODE === "pc" ? "Sur le PC, toutes les sources sont interrogées (y compris LinkedIn et les sites qui demandent un navigateur)." :
      "Depuis l'iPhone, la veille tourne dans GitHub Actions (sources sans connexion). LinkedIn et les sources qui demandent un navigateur sont faites au prochain démarrage du PC."}</p>
      <button class="primary wide" id="go" ${cur ? "disabled" : ""}>${cur ? "Veille en cours…" : "Lancer la veille"}</button></div>
    ${pcWait ? `<div class="note warn">Sources PC en attente (LinkedIn, navigateur) : elles tourneront au prochain démarrage du PC.</div>` : ""}
    <div id="live"></div><h3>Historique</h3>${rows.map(runCard).join("")}`;
  $("#go").onclick = launchVeille;
  if (cur) { showLive(cur); timer = setInterval(async () => { const r = await q(sb.from("demandes_veille").select("*").eq("id", cur.id).single()); showLive(r); if (!["en_attente", "en_cours"].includes(r.statut)) { clearInterval(timer); veille(); } }, 2500); }
}

async function launchVeille() {
  $("#go").disabled = true;
  if (MODE === "pc") {
    await q(sb.from("demandes_veille").insert({ type: "veille", origine: "pc" }));
  } else {
    const { data, error } = await sb.functions.invoke("lancer-veille", { body: {} });
    if (error || data?.erreur) { toast("Erreur : " + (data?.erreur || error.message)); $("#go").disabled = false; return; }
  }
  setTimeout(veille, 800);
}

function showLive(d) {
  const p = d.progression || {};
  const names = Object.keys(p);
  const done = names.filter((n) => !["en cours", "en attente"].includes(p[n].etat)).length;
  $("#live").innerHTML = `<div class="card"><div class="row between"><b>${d.statut === "en_attente" ? "En attente de démarrage…" : "En cours"}</b><span class="small muted">${done}/${names.length || "?"} sources</span></div>
    <div class="bar" style="margin:8px 0"><i style="width:${names.length ? (100 * done) / names.length : 5}%"></i></div>
    ${d.github_run_url ? `<a class="small" href="${esc(d.github_run_url)}" target="_blank" rel="noopener">Voir l'exécution GitHub</a>` : ""}
    ${names.map((n) => `<div class="row between small"><span>${esc(n)}</span><span class="${p[n].etat === "erreur" ? "pill bad" : p[n].etat === "ok" ? "pill ok" : "pill"}">${esc(p[n].etat)}${p[n].nouvelles != null ? ` · +${p[n].nouvelles}` : ""}</span></div>`).join("")}</div>`;
}

function runCard(r) {
  const s = r.resultat || {};
  const causes = (s.causes || []).map((c) => `<li>${esc(c)}</li>`).join("");
  return `<div class="card"><div class="row between"><b>${fmtDT(r.created_at)}</b><span class="pill ${r.statut === "terminee" ? "ok" : r.statut === "erreur" ? "bad" : "warn"}">${esc(r.statut)}${r.attend_pc ? " · attend le PC" : ""}</span></div>
    <div class="small muted">${esc(r.origine)} ${r.github_run_url ? `· <a href="${esc(r.github_run_url)}" target="_blank" rel="noopener">GitHub</a>` : ""}</div>
    ${r.resultat ? `<div class="small">${s.nouvelles ?? 0} nouvelles offres · ${s.doublons ?? 0} doublons · ${s.erreurs ?? 0} erreurs · ${s.ecartees ?? 0} écartées par le filtre${s.expirees != null ? ` · ${s.expirees} expirées` : ""}</div>` : ""}
    ${s.erreur ? `<div class="small" style="color:var(--bad)">${esc(s.erreur)}</div>` : ""}
    ${causes ? `<details class="small"><summary>Erreurs et causes</summary><ul>${causes}</ul></details>` : ""}
    ${s.par_source ? `<details class="small"><summary>Détail par source</summary>${Object.entries(s.par_source).map(([k, v]) => `<div>${esc(k)} : ${v.lues} lues, +${v.nouvelles}, ${v.doublons} doublons, ${v.erreurs} err.</div>`).join("")}</details>` : ""}</div>`;
}

/* ---------------------------------------------------------------- 3. offres et entreprises */
function offerCard(o) {
  const srcs = (o.sources || []).map((s) => s.source).join(", ");
  return `<div class="card tap" onclick="offerDetail(${o.id})"><div class="row" style="flex-wrap:nowrap"><div class="score">${o.score ?? "–"}</div>
    <div style="min-width:0"><div class="title">${esc(o.titre)}</div><div class="small muted">${esc(o.entreprise || "")} · ${esc(o.ville || "lieu ?")}${o.km != null ? ` · ${Math.round(o.km)} km` : ""}${o.trajet_min ? ` · ~${o.trajet_min} min TC` : ""}</div>
    <div class="small muted ellipsis">${esc(o.score_raison || "")}${srcs ? " · " + esc(srcs) : ""}</div></div></div></div>`;
}
function entCard(e) {
  return `<div class="card tap" onclick="entDetail(${e.id})"><div class="row" style="flex-wrap:nowrap"><div class="score">${e.score ?? "–"}</div>
    <div style="min-width:0"><div class="title">${esc(e.nom)}</div><div class="small muted">${esc(e.ville || "?")}${e.km != null ? ` · ${Math.round(e.km)} km` : ""}${e.trajet_min ? ` · ~${e.trajet_min} min TC` : ""}</div>
    <div class="small muted ellipsis">${esc(e.score_raison || "")}</div></div></div></div>`;
}

async function offres() {
  const seg = `<div class="seg">${[["offres", "Offres"], ["entreprises", "Spontanées"], ["rapport", "Rapport"]].map(([k, l]) => `<button class="${ST.offSeg === k ? "on" : ""}" onclick="ST.offSeg='${k}';offres()">${l}</button>`).join("")}</div>`;
  if (ST.offSeg === "rapport") return rapport(seg);
  const isOff = ST.offSeg === "offres";
  const f = isOff ? ST.fOff : ST.fEnt;
  $("#view").innerHTML = seg + `<input id="fq" placeholder="Rechercher (titre, entreprise, ville)" value="${esc(f.q)}">
    <div class="filters" style="margin-top:8px">
      <select id="fkm">${[[999, "Toute l'IDF"], [30, "≤ 30 km"], [15, "≤ 15 km"], [50, "≤ 50 km"]].map(([v, l]) => `<option value="${v}" ${f.km == v ? "selected" : ""}>${l}</option>`).join("")}</select>
      ${isOff ? `<select id="fst">${[["ouvertes", "Ouvertes"], ["nouvelle", "Nouvelles"], ["validee", "Validées"], ["postulee", "Postulées"], ["expiree", "Expirées"], ["ecartee", "Écartées"], ["toutes", "Toutes"]].map(([v, l]) => `<option value="${v}" ${f.statut === v ? "selected" : ""}>${l}</option>`).join("")}</select>`
      : `<select id="fst">${[["retenue", "Retenues"], ["a_qualifier", "À qualifier"], ["ecartee", "Écartées"], ["toutes", "Toutes"]].map(([v, l]) => `<option value="${v}" ${f.statut === v ? "selected" : ""}>${l}</option>`).join("")}</select>
        <select id="fct">${[["tous", "Tous contacts"], ["avec", "Avec contact vérifié"], ["sans", "Sans contact"]].map(([v, l]) => `<option value="${v}" ${f.contact === v ? "selected" : ""}>${l}</option>`).join("")}</select>`}
    </div><div id="list"><div class="center muted">…</div></div>`;
  const re = () => { f.q = $("#fq").value; f.km = +$("#fkm").value; f.statut = $("#fst").value; if ($("#fct")) f.contact = $("#fct").value; loadList(); };
  $("#fq").oninput = debounce(re, 350); $("#fkm").onchange = re; $("#fst").onchange = re; if ($("#fct")) $("#fct").onchange = re;
  loadList();
}
function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }

async function loadList() {
  const isOff = ST.offSeg === "offres";
  const f = isOff ? ST.fOff : ST.fEnt;
  let rows;
  if (isOff) {
    let x = sb.from("offres").select("id,titre,entreprise,ville,km,trajet_min,score,score_raison,sources,statut").order("score", { ascending: false }).limit(200);
    if (f.statut === "ouvertes") x = x.in("statut", ["nouvelle", "validee"]); else if (f.statut !== "toutes") x = x.eq("statut", f.statut);
    if (f.km < 999) x = x.lte("km", f.km);
    if (f.q) x = x.or(`titre.ilike.%${f.q}%,entreprise.ilike.%${f.q}%,ville.ilike.%${f.q}%`);
    rows = await q(x);
    $("#list").innerHTML = `<p class="small muted">${rows.length} offre(s)</p>` + (rows.map(offerCard).join("") || '<p class="muted">Aucune offre avec ces filtres.</p>');
  } else {
    let x = sb.from("entreprises").select("id,nom,ville,km,trajet_min,score,score_raison,statut,contacts(type,deduit)").order("score", { ascending: false, nullsFirst: false }).limit(300);
    if (f.statut !== "toutes") x = x.eq("statut", f.statut);
    if (f.km < 999) x = x.lte("km", f.km);
    if (f.q) x = x.or(`nom.ilike.%${f.q}%,ville.ilike.%${f.q}%,activite.ilike.%${f.q}%`);
    rows = await q(x);
    if (f.contact !== "tous") rows = rows.filter((e) => { const v = (e.contacts || []).some((c) => ["nominatif", "generique", "formulaire"].includes(c.type) && !c.deduit); return f.contact === "avec" ? v : !v; });
    $("#list").innerHTML = `<p class="small muted">${rows.length} entreprise(s)</p>` + (rows.map(entCard).join("") || '<p class="muted">Aucune entreprise avec ces filtres.</p>');
  }
}

function sheet(html) { $("#sheetbody").innerHTML = html + `<p><button class="wide" onclick="closeSheet()">Fermer</button></p>`; const d = $("#sheet"); if (!d.open) d.showModal(); }
function closeSheet() { $("#sheet").close(); }

async function offerDetail(id) {
  const o = await q(sb.from("offres").select("*").eq("id", id).single());
  const c = await q(sb.from("candidatures").select("id,statut").eq("offre_id", id));
  sheet(`<h2>${esc(o.titre)}</h2><div class="muted">${esc(o.entreprise || "")} · ${esc(o.ville || "")}${o.km != null ? ` · ${Math.round(o.km)} km de Trappes` : ""}${o.trajet_min ? ` · ~${o.trajet_min} min en transports (estimé)` : ""}</div>
    <div class="row" style="margin:8px 0"><span class="score">${o.score ?? "–"}</span><span class="small">${esc(o.score_raison || "")}</span></div>
    <div class="small"><b>Dates :</b> ${esc(o.dates || "—")} · <b>Durée :</b> ${esc(o.duree || "—")} ${o.date_a_confirmer ? '<span class="pill warn">date à confirmer</span>' : ""}</div>
    <div class="small"><b>Type :</b> ${esc(o.type_stage || "")} · <b>Statut :</b> ${esc(o.statut)} · <b>Détectée :</b> ${fmtDate(o.detecte_le)}${o.lien_ok === false ? ' · <span class="pill bad">lien mort</span>' : ""}</div>
    <div class="small"><b>Sources :</b> ${(o.sources || []).map((s) => s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.source)}</a>` : esc(s.source)).join(", ")}</div>
    ${o.url ? `<p><a class="btn wide" href="${esc(o.url)}" target="_blank" rel="noopener">Ouvrir l'offre</a></p>` : ""}
    <details><summary class="small">Description</summary><pre class="mail small">${esc((o.description || "").slice(0, 3000))}</pre></details>
    <div class="row" style="margin-top:12px">${c.length ? `<span class="pill acc">Mail : ${esc(CST[c[0].statut]?.[0] || c[0].statut)}</span>` : `<button class="primary" onclick="valider('offre',${o.id})">Valider (générer le mail)</button>`}
    <button onclick="setOffre(${o.id},'ecartee')">Écarter</button></div>`);
}
async function setOffre(id, statut) { await q(sb.from("offres").update({ statut }).eq("id", id)); closeSheet(); loadList(); }

async function entDetail(id) {
  const e = await q(sb.from("entreprises").select("*, contacts(*)").eq("id", id).single());
  const c = await q(sb.from("candidatures").select("id,statut").eq("entreprise_id", id).eq("est_relance", false));
  const cts = (e.contacts || []).sort((a, b) => a.priorite - b.priorite);
  const L = (u, t) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t || u)}</a>` : "");
  sheet(`<h2>${esc(e.nom)}</h2><div class="muted">${esc(e.adresse || e.ville || "")}${e.km != null ? ` · ${Math.round(e.km)} km de Trappes` : ""}${e.trajet_min ? ` · ~${e.trajet_min} min en transports (estimé)` : ""}</div>
    <div class="row" style="margin:8px 0"><span class="score">${e.score ?? "–"}</span><span class="small">${esc(e.score_raison || "")}</span></div>
    <div class="small">${esc(e.activite || "")}</div>
    <div class="small muted">${[e.secteur, e.effectif && e.effectif + " sal.", e.groupe, e.naf].filter(Boolean).map(esc).join(" · ")} · familles ${esc((e.familles || []).join(", "))}</div>
    ${e.statut === "ecartee" ? `<div class="note warn">Écartée : ${esc(e.raison_ecart || "")}</div>` : ""}
    ${e.atelier_preuve ? `<div class="note"><b>Atelier :</b> ${esc(e.atelier_preuve)}</div>` : ""}
    ${e.preuve_stage ? `<div class="note"><b>Stages :</b> ${esc(e.preuve_stage)} ${L(e.preuve_url, "source")}</div>` : ""}
    <div class="row small">${L(e.site_web, "Site")} ${L(e.page_stages_url, "Page stages")} ${L(e.formulaire_url, "Formulaire spontané")}</div>
    <h3>Contacts</h3>${cts.map((x) => `<div class="card small"><div class="row between"><b>${esc(x.type)}</b>${x.deduit ? `<span class="pill warn">déduit${x.valide_par_moi ? ", validé" : ", à valider"}</span>` : '<span class="pill ok">publié</span>'}</div>
      <div>${x.valeur.startsWith("http") ? L(x.valeur) : esc(x.valeur)} ${x.nom ? "· " + esc(x.nom) : ""} ${x.fonction ? "· " + esc(x.fonction) : ""}</div>
      <div class="muted">source : ${L(x.source_url, "page")} · ${esc(x.source_date || "")}${x.mx_ok === false ? " · MX invalide" : ""}</div>
      ${x.deduit && !x.valide_par_moi ? `<button class="small" onclick="validerContact(${x.id},${e.id})">J'ai vérifié cette adresse</button>` : ""}</div>`).join("") || '<p class="muted small">Aucun contact vérifié.</p>'}
    ${e.notes ? `<details class="small"><summary>Notes</summary><pre class="mail">${esc(e.notes)}</pre></details>` : ""}
    <div class="row" style="margin-top:12px">${c.length ? `<span class="pill acc">Mail : ${esc(CST[c[0].statut]?.[0] || c[0].statut)}</span>` : `<button class="primary" onclick="valider('entreprise',${e.id})">Valider (générer le mail)</button>`}</div>`);
}
async function validerContact(cid, eid) { await q(sb.from("contacts").update({ valide_par_moi: true }).eq("id", cid)); await q(sb.from("candidatures").update({ deduit_a_valider: false }).eq("contact_id", cid)); entDetail(eid); }

async function valider(kind, id) {
  const row = { statut: "a_generer" };
  if (kind === "offre") {
    const o = await q(sb.from("offres").select("entreprise_id").eq("id", id).single());
    Object.assign(row, { offre_id: id, entreprise_id: o.entreprise_id });
    await q(sb.from("offres").update({ statut: "validee" }).eq("id", id));
  } else {
    row.entreprise_id = id;
    await q(sb.from("entreprises").update({ valide: true }).eq("id", id));
  }
  await q(sb.from("candidatures").insert(row));
  closeSheet();
  toast(MODE === "pc" ? "Mail en cours de génération (onglet Brouillons)." : "Validé : le mail sera généré au prochain démarrage du PC.");
}

async function rapport(seg) {
  const r = await q(sb.from("rapports").select("*").order("cree_le", { ascending: false }).limit(1));
  $("#view").innerHTML = seg + (r[0] ? `<div class="small muted">Rapport du ${fmtDT(r[0].cree_le)}</div><div class="md card">${marked.parse(r[0].contenu_md)}</div>` : '<p class="muted">Rapport pas encore généré.</p>');
}

/* ---------------------------------------------------------------- 4. mails envoyés */
async function mails() {
  const segs = [["tous", "Tous"], ["a_traiter", "À traiter"], ["sans_reponse", "Sans réponse"], ["refus", "Refus"], ["entretien", "Entretien"], ["demande_info", "Demande d'info"], ["a_repondre", "À répondre"]];
  let x = sb.from("candidatures").select("*, entreprises(nom), offres(titre), reponses(*)").eq("statut", "envoyee").order("envoyee_le", { ascending: false });
  if (ST.mailSeg === "a_traiter") x = x.in("reponse_statut", ["entretien", "demande_info", "a_repondre"]);
  else if (ST.mailSeg !== "tous") x = x.eq("reponse_statut", ST.mailSeg);
  const rows = await q(x);
  $("#view").innerHTML = `<div class="seg">${segs.map(([k, l]) => `<button class="${ST.mailSeg === k ? "on" : ""}" onclick="ST.mailSeg='${k}';mails()">${l}</button>`).join("")}</div>
    <div class="row"><button class="wide" id="fetchrep">Récupérer les réponses</button></div>
    ${rows.map((c) => { const [lab, cls] = REP[c.reponse_statut] || [c.reponse_statut, ""]; return `<div class="card tap" onclick="mailDetail(${c.id})"><div class="row between"><b class="ellipsis">${esc(c.entreprises?.nom || c.destinataire)}</b><span class="pill ${cls}">${lab}</span></div>
      <div class="small muted">${c.est_relance ? "Relance · " : ""}${esc(c.destinataire)} · ${fmtDT(c.envoyee_le)}</div>${c.reponses?.length ? `<div class="small">${esc(c.reponses[c.reponses.length - 1].resume || "")}</div>` : ""}</div>`; }).join("") || '<p class="muted">Aucun mail ici.</p>'}`;
  $("#fetchrep").onclick = async () => { await q(sb.from("demandes_veille").insert({ type: "reponses", origine: MODE === "pc" ? "pc" : "pwa", attend_pc: MODE !== "pc" })); toast(MODE === "pc" ? "Lecture de Gmail en cours…" : "Demande enregistrée : lecture au prochain démarrage du PC."); };
}

async function mailDetail(id) {
  const c = await q(sb.from("candidatures").select("*, entreprises(nom), reponses(*)").eq("id", id).single());
  sheet(`<h2>${esc(c.entreprises?.nom || "")}</h2><div class="small muted">À ${esc(c.destinataire)} · ${fmtDT(c.envoyee_le)} · fil Gmail ${esc(c.gmail_thread_id || "")}</div>
    <div class="card"><b>${esc(c.objet)}</b><pre class="mail">${esc(c.corps)}</pre>${c.piece_jointe ? `<div class="small muted">Pièce jointe : ${esc(c.piece_jointe)}</div>` : ""}</div>
    <h3>Réponses</h3>${(c.reponses || []).map((r) => `<div class="card"><div class="row between"><b>${esc(r.expediteur)}</b><span class="pill ${(REP[r.classement] || [])[1] || ""}">${esc((REP[r.classement] || [r.classement])[0])}</span></div>
      <div class="small muted">${fmtDT(r.recu_le)} · ${esc(r.sujet || "")}</div><div class="small"><b>${esc(r.resume || "")}</b></div><pre class="mail small">${esc((r.corps || "").slice(0, 2000))}</pre></div>`).join("") || '<p class="muted small">Pas encore de réponse.</p>'}
    <label>Statut</label><select id="rs">${Object.entries(REP).map(([k, [l]]) => `<option value="${k}" ${c.reponse_statut === k ? "selected" : ""}>${l}</option>`).join("")}</select>`);
  $("#rs").onchange = async (ev) => { await q(sb.from("candidatures").update({ reponse_statut: ev.target.value }).eq("id", id)); };
}

/* ---------------------------------------------------------------- 5. brouillons */
async function drafts() {
  const rows = await q(sb.from("candidatures").select("*, entreprises(nom), offres(titre,url)").in("statut", ["a_generer", "brouillon", "a_envoyer", "erreur"]).order("updated_at", { ascending: false }));
  $("#view").innerHTML = `<h2>Brouillons</h2><p class="small muted">Rien ne part sans ton clic « Envoyer ». ${MODE === "pc" ? "Le PC envoie au plus 20 mails par jour, espacés de 2 à 5 minutes." : "Un mail mis en file part dès que le PC est allumé (20 par jour max, 2 à 5 min d'écart)."}</p>
    ${rows.map((c) => { const [lab, cls] = CST[c.statut]; return `<div class="card tap" onclick="draftDetail(${c.id})"><div class="row between"><b class="ellipsis">${esc(c.entreprises?.nom || c.offres?.titre || "?")}</b><span class="pill ${cls}">${lab}</span></div>
      <div class="small muted">${c.est_relance ? "Relance · " : ""}${esc(c.destinataire || "destinataire à compléter")}${c.deduit_a_valider ? " · adresse déduite à valider" : ""}</div>${c.erreur ? `<div class="small" style="color:var(--bad)">${esc(c.erreur)}</div>` : ""}</div>`; }).join("") || '<p class="muted">Aucun brouillon. Valide une offre ou une entreprise.</p>'}`;
  if (rows.some((c) => ["a_generer", "a_envoyer"].includes(c.statut))) timer = setInterval(() => TAB === "drafts" && !$("#sheet").open && drafts(), 8000);
}

async function draftDetail(id) {
  const c = await q(sb.from("candidatures").select("*, entreprises(nom), offres(titre,url)").eq("id", id).single());
  const editable = ["brouillon", "erreur"].includes(c.statut);
  sheet(`<h2>${esc(c.entreprises?.nom || c.offres?.titre || "")}</h2>
    ${c.statut === "a_generer" ? `<div class="note warn">Le mail sera généré par Claude ${MODE === "pc" ? "dans un instant" : "au prochain démarrage du PC"}.</div>` : ""}
    ${c.statut === "a_envoyer" ? `<div class="note warn">En file d'envoi : ${MODE === "pc" ? "part dans les prochaines minutes." : "partira dès que le PC sera allumé."}</div>` : ""}
    ${c.erreur ? `<div class="note warn">${esc(c.erreur)}</div>` : ""}
    <label>Destinataire</label><input id="to" value="${esc(c.destinataire || "")}" ${editable ? "" : "disabled"} inputmode="email">
    <div class="small muted">Source du contact : ${esc(c.contact_source || "—")}</div>
    ${c.deduit_a_valider ? `<label class="row small"><input type="checkbox" id="okded" style="width:auto;min-height:auto"> J'ai vérifié cette adresse déduite (obligatoire avant l'envoi)</label>` : ""}
    <label>Objet</label><input id="subj" value="${esc(c.objet || "")}" ${editable ? "" : "disabled"}>
    <label>Message (${(c.corps || "").split(/\s+/).filter(Boolean).length} mots)</label><textarea id="body" ${editable ? "" : "disabled"}>${esc(c.corps || "")}</textarea>
    <div class="small muted">Pièce jointe : ${esc(c.piece_jointe || "aucune (relance)")}</div>
    ${editable ? `<div class="row" style="margin-top:12px"><button onclick="saveDraft(${id})">Enregistrer</button><button class="primary" onclick="sendDraft(${id})">Envoyer</button>
      <button onclick="regen(${id})">Régénérer</button><button class="danger" onclick="cancelDraft(${id})">Annuler</button></div>` : ""}
    ${c.statut === "a_envoyer" ? `<p><button class="wide" onclick="unqueue(${id})">Retirer de la file</button></p>` : ""}`);
}
function draftVals() { return { destinataire: $("#to").value.trim(), objet: $("#subj").value, corps: $("#body").value }; }
async function saveDraft(id) { await q(sb.from("candidatures").update(draftVals()).eq("id", id)); toast("Enregistré."); }
async function sendDraft(id) {
  const v = draftVals();
  if (!/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(v.destinataire)) return toast("Destinataire invalide.");
  if ($("#okded") && !$("#okded").checked) return toast("Coche d'abord la vérification de l'adresse déduite.");
  if ($("#okded")) v.deduit_a_valider = false;
  if (!confirm(`Envoyer ce mail à ${v.destinataire} ?`)) return;
  await q(sb.from("candidatures").update({ ...v, statut: "a_envoyer", erreur: null }).eq("id", id));
  closeSheet(); drafts();
  toast(MODE === "pc" ? "En file : envoi dans les prochaines minutes." : "En file : partira dès que le PC sera allumé.");
}
async function regen(id) { await q(sb.from("candidatures").update({ statut: "a_generer", erreur: null }).eq("id", id)); closeSheet(); drafts(); }
async function cancelDraft(id) { if (confirm("Annuler ce brouillon ?")) { await q(sb.from("candidatures").update({ statut: "annulee" }).eq("id", id)); closeSheet(); drafts(); } }
async function unqueue(id) { await q(sb.from("candidatures").update({ statut: "brouillon" }).eq("id", id)); closeSheet(); drafts(); }

boot();
