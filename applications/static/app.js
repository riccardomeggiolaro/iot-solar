"use strict";
// ==== utilità =================================================
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = (v, d = 1) => v.toLocaleString("it-IT", { maximumFractionDigits: d, minimumFractionDigits: 0 });
const kw = (w) => w == null ? "–" : nf(w / 1000) + " kW";
const kwh = (wh) => wh == null ? "–" : wh < 1000 ? Math.round(wh) + " Wh" : nf(wh / 1000, wh < 100000 ? 1 : 0) + " kWh";
const eur = (v) => (v ?? 0).toLocaleString("it-IT", { style: "currency", currency: "EUR" });
const statusColor = { MPPT: "var(--ok)", THROTTLED: "var(--ok)", SLEEPING: "var(--muted)", FAULT: "var(--crit)" };
const ALARM_NAMES = {
	OFFLINE: "Non comunica", FAULT: "Inverter in guasto", OVERTEMP: "Sovratemperatura",
	UNDERPERF_EXPECTED: "Sotto l'atteso", UNDERPERF_PEER: "Sotto gli altri inverter", PLANT_UNDERPERF: "Calo dell'impianto",
};

const state = { token: null, user: null, view: null, timer: null, selected: null, config: null, simDevices: {} };
try { state.token = localStorage.getItem("iot-solar-token"); } catch { }

async function api(path, opts = {}) {
	const headers = { ...(opts.headers || {}) };
	if (state.token) headers.Authorization = "Bearer " + state.token;
	if (opts.json !== undefined) { headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(opts.json); }
	const res = await fetch(path, { ...opts, headers });
	if (res.status === 401 && path !== "/api/auth/login") { logout(); throw new Error("Sessione scaduta"); }
	const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
	if (!res.ok) throw new Error(typeof data?.detail === "string" ? data.detail : "Errore " + res.status);
	return data;
}

function notice(el, text, kind = "ok") {
	el.textContent = text; el.className = "notice " + kind; el.hidden = !text;
	if (kind === "ok" && text) setTimeout(() => { el.hidden = true; }, 4000);
}

// ==== sessione ================================================
function setToken(token) {
	state.token = token;
	try { token ? localStorage.setItem("iot-solar-token", token) : localStorage.removeItem("iot-solar-token"); } catch { }
}

function logout() {
	setToken(null); state.user = null; clearInterval(state.timer);
	show("login");
}

function show(screen) {
	$("view-login").hidden = screen !== "login";
	$("view-password").hidden = screen !== "password";
	$("app").hidden = screen !== "app";
}

async function boot() {
	try { $("footer").textContent = "IoT-Solar " + (await (await fetch("/api/version")).json()).version; } catch { }
	if (!state.token) return show("login");
	try { state.user = await api("/api/auth/me"); } catch { return; }
	if (state.user.must_change_password) return showPassword(true);
	startApp();
}

function showPassword(forced) {
	$("password-form").reset();
	$("password-forced").hidden = !forced;
	$("password-cancel").hidden = forced;
	$("password-error").hidden = true;
	show("password");
}

$("login-form").onsubmit = async (e) => {
	e.preventDefault();
	const f = new FormData(e.target);
	try {
		const r = await api("/api/auth/login", { method: "POST", json: { username: f.get("username"), password: f.get("password") } });
		setToken(r.token); state.user = r.user;
		e.target.reset(); $("login-error").hidden = true;
		r.user.must_change_password ? showPassword(true) : startApp();
	} catch (err) { notice($("login-error"), err.message, "err"); }
};

$("password-form").onsubmit = async (e) => {
	e.preventDefault();
	const f = new FormData(e.target);
	if (f.get("new_password") !== f.get("repeat")) return notice($("password-error"), "Le due password non coincidono", "err");
	try {
		await api("/api/auth/password", { method: "POST", json: { old_password: f.get("old_password"), new_password: f.get("new_password") } });
		state.user = await api("/api/auth/me");
		startApp();
	} catch (err) { notice($("password-error"), err.message, "err"); }
};
$("password-cancel").onclick = () => startApp();
$("btn-password").onclick = () => showPassword(false);
$("btn-logout").onclick = logout;

function startApp() {
	show("app");
	$("user-label").textContent = `${state.user.username} · ${state.user.level_name}`;
	document.querySelectorAll("[data-level]").forEach((el) => { el.hidden = state.user.level < +el.dataset.level; });
	route();
}

// ==== navigazione =============================================
const VIEWS = { dashboard: loadDashboard, report: loadReport, config: loadConfig, users: loadUsers };
window.addEventListener("hashchange", () => state.user && route());

function route() {
	let view = location.hash.replace("#/", "") || "dashboard";
	const link = document.querySelector(`nav a[data-view="${view}"]`);
	if (!VIEWS[view] || !link || link.hidden) view = "dashboard";
	state.view = view;
	document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === view));
	for (const v of Object.keys(VIEWS)) $("view-" + v).hidden = v !== view;
	clearInterval(state.timer);
	VIEWS[view]();
	if (view === "dashboard") state.timer = setInterval(loadDashboard, 5000);
}

// ==== dashboard ===============================================
async function loadDashboard() {
	let p;
	try { p = await api("/api/plant"); } catch { return; }
	$("plant-name").textContent = p.plant;
	$("sim-banner").hidden = !p.simulator;
	$("k-power").textContent = kw(p.power_w);
	$("k-power-sub").textContent = p.expected_w ? `atteso ${kw(p.expected_w)} · ${nf(p.kwp)} kWp` : `${nf(p.kwp)} kWp installati`;
	$("k-energy").textContent = kwh(p.energy_today_wh);
	$("k-energy-sub").textContent = `valore ${eur(p.energy_today_wh / 1000 * p.energy_price_eur_kwh)}`;
	$("k-loss").textContent = eur(p.lost_today_eur);
	$("k-loss-sub").textContent = kwh(p.lost_today_wh) + " non prodotti";
	$("k-irr").textContent = p.poa_wm2 == null ? "–" : Math.round(p.poa_wm2) + " W/m²";

	const inv = p.devices.filter((d) => d.type === "inverter");
	if (!inv.some((d) => d.name === state.selected)) state.selected = inv[0]?.name ?? null;
	$("devices").innerHTML = inv.map((d) => {
		const v = d.values || {};
		const st = d.online ? (v.status_text || "?") : "OFFLINE";
		const max = Math.max(v.ac_power_w || 0, d.expected_w || 0, 1);
		const ratio = d.expected_w ? (v.ac_power_w || 0) / d.expected_w : null;
		const barColor = ratio == null ? "var(--ok)" : ratio < 0.8 ? "var(--crit)" : ratio < 0.9 ? "var(--warn)" : "var(--ok)";
		return `<tr class="dev ${d.name === state.selected ? "sel" : ""}" data-name="${esc(d.name)}">
			<td><b>${esc(d.name)}</b><div class="small muted">${nf(d.kwp)} kWp</div></td>
			<td><span class="dot" style="background:${d.online ? statusColor[st] || "var(--warn)" : "var(--crit)"}"></span>${esc(st)}</td>
			<td>${d.online ? kw(v.ac_power_w) : "–"}</td>
			<td><div class="bar"><i style="width:${(v.ac_power_w || 0) / max * 100}%;background:${barColor}"></i>${d.expected_w ? `<b style="left:${d.expected_w / max * 100}%"></b>` : ""}</div>
				<div class="small muted">${ratio == null ? "" : Math.round(ratio * 100) + "%"}</div></td>
			<td>${kwh(d.energy_today_wh)}</td>
			<td>${v.temperature_c == null || !d.online ? "–" : Math.round(v.temperature_c) + " °C"}</td></tr>`;
	}).join("") || '<tr><td colspan="6" class="empty">Nessun inverter configurato.</td></tr>';
	document.querySelectorAll("tr.dev").forEach((tr) => tr.onclick = () => { state.selected = tr.dataset.name; loadDashboard(); });

	const canAck = state.user.level >= 2;
	$("alarms").innerHTML = p.active_alarms.length ? p.active_alarms.map((a) => `
		<div class="alarm ${esc(a.severity)}">
			<div class="t">${a.message.startsWith(a.device) ? "" : esc(a.device === "IMPIANTO" ? "Impianto" : a.device) + " · "}${esc(a.message)}</div>
			<div class="h">${esc(a.hint)}</div>
			<div class="m"><span>dal ${new Date(a.started_at * 1000).toLocaleString("it-IT")}</span>
			${a.lost_wh > 0 ? `<span>persi ${kwh(a.lost_wh)} (${eur(a.lost_wh / 1000 * p.energy_price_eur_kwh)})</span>` : ""}
			${a.acknowledged ? "<span>✓ preso in carico</span>" : canAck ? `<button data-ack="${a.id}">Prendi in carico</button>` : ""}</div>
		</div>`).join("") : '<div class="empty">Nessun allarme: impianto regolare.</div>';
	document.querySelectorAll("[data-ack]").forEach((b) => b.onclick = async () => {
		await api(`/api/alarms/${b.dataset.ack}/ack`, { method: "POST" }); loadDashboard();
	});

	if (state.selected) drawHistory(state.selected);
	$("sim").hidden = !p.simulator;
	if (p.simulator) loadSim();
}

async function drawHistory(name) {
	const rows = await api(`/api/devices/${encodeURIComponent(name)}/history?hours=24`);
	$("chart-title").textContent = `Storico ${name} (24 h)`;
	const svg = $("chart"), W = 1000, H = 260, pad = { l: 50, r: 10, t: 10, b: 24 };
	if (rows.length < 2) { svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle">Dati insufficienti</text>`; return; }
	const t0 = rows[0].ts, t1 = rows[rows.length - 1].ts;
	const ymax = Math.max(...rows.map((r) => Math.max(r.ac_power_w || 0, r.expected_w || 0)), 1) * 1.1;
	const x = (t) => pad.l + (t - t0) / Math.max(t1 - t0, 1) * (W - pad.l - pad.r);
	const y = (v) => H - pad.b - (v / ymax) * (H - pad.t - pad.b);
	const path = (key) => rows.filter((r) => r[key] != null).map((r, i) => `${i ? "L" : "M"}${x(r.ts).toFixed(1)},${y(r[key]).toFixed(1)}`).join("");
	let grid = "";
	for (let i = 0; i <= 4; i++) {
		const v = ymax / 4 * i;
		grid += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${nf(v / 1000, 0)} kW</text>`;
		const t = t0 + (t1 - t0) / 4 * i;
		grid += `<text x="${x(t)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === 4 ? "end" : "middle"}">${new Date(t * 1000).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}</text>`;
	}
	svg.innerHTML = grid +
		`<path d="${path("expected_w")}" fill="none" stroke="var(--exp)" stroke-width="2" stroke-dasharray="6 4" vector-effect="non-scaling-stroke"/>` +
		`<path d="${path("ac_power_w")}" fill="none" stroke="var(--accent)" stroke-width="2.5" vector-effect="non-scaling-stroke"/>`;
}

async function loadSim() {
	let s;
	try { s = await api("/api/simulator"); } catch { return; }
	const sel = $("sim-dev"), names = Object.keys(s.devices);
	if (sel.options.length !== names.length) {
		sel.innerHTML = names.map((n) => `<option>${esc(n)}</option>`).join("");
		sel.onchange = fillSim;
		state.simDevices = s.devices; fillSim();
	}
	state.simDevices = s.devices;
	$("sim-state").textContent = `Ora simulata ${s.state.sim_time} · sole ${s.state.sun_elevation}° · nuvolosità ${s.state.cloud_factor}`;
}

function fillSim() {
	const d = state.simDevices[$("sim-dev").value] || {};
	$("sim-soiling").value = d.soiling ?? 0; $("sim-string").value = d.string_loss ?? 0;
	$("sim-fault").checked = !!d.fault; $("sim-offline").checked = !!d.offline;
}

$("sim-apply").onclick = async () => {
	const name = $("sim-dev").value;
	const body = { offline: $("sim-offline").checked };
	if (state.simDevices[name]?.type === "inverter") Object.assign(body, {
		soiling: +$("sim-soiling").value, string_loss: +$("sim-string").value, fault: $("sim-fault").checked });
	state.simDevices[name] = await api(`/api/simulator/${encodeURIComponent(name)}`, { method: "POST", json: body });
	loadDashboard();
};

// ==== report ==================================================
const monthInput = $("report-month");
monthInput.value = new Date().toISOString().slice(0, 7);
monthInput.onchange = loadReport;

async function loadReport() {
	const [year, month] = monthInput.value.split("-").map(Number);
	if (!year) return;
	let r;
	try { r = await api(`/api/report/monthly?year=${year}&month=${month}`); } catch { return; }
	const perf = r.performance == null ? "–" : Math.round(r.performance * 100) + " %";
	const kpi = (label, value, sub = "", cls = "") => `<div class="card kpi ${cls}"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
	$("report-kpis").innerHTML =
		kpi("Energia prodotta", kwh(r.energy_kwh * 1000), `attesa ${kwh(r.expected_kwh * 1000)}`) +
		kpi("Rendimento", perf, `${nf(r.specific_kwh_kwp)} kWh/kWp`) +
		kpi("Valore energia", eur(r.revenue_eur), `a ${nf(r.price, 3)} €/kWh`) +
		kpi("Perdite stimate", eur(r.lost_eur), kwh(r.lost_kwh * 1000) + " non prodotti", "loss");

	const svg = $("report-chart"), W = 1000, H = 220, pad = { l: 50, r: 10, t: 10, b: 22 };
	const max = Math.max(...r.daily.map((d) => Math.max(d.energy_wh, d.expected_wh)), 1) * 1.1;
	const bw = (W - pad.l - pad.r) / r.daily.length;
	const y = (v) => H - pad.b - v / max * (H - pad.t - pad.b);
	let g = "";
	for (let i = 0; i <= 4; i++) {
		const v = max / 4 * i;
		g += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${nf(v / 1000, 0)}</text>`;
	}
	r.daily.forEach((d, i) => {
		const x0 = pad.l + i * bw;
		g += `<rect x="${x0 + bw * 0.12}" width="${bw * 0.38}" y="${y(d.energy_wh)}" height="${H - pad.b - y(d.energy_wh)}" fill="var(--accent)"/>`;
		g += `<rect x="${x0 + bw * 0.5}" width="${bw * 0.38}" y="${y(d.expected_wh)}" height="${H - pad.b - y(d.expected_wh)}" fill="var(--exp)" opacity=".55"/>`;
		if (d.day % 2) g += `<text x="${x0 + bw / 2}" y="${H - 6}" text-anchor="middle">${d.day}</text>`;
	});
	svg.innerHTML = g;

	$("report-inverters").innerHTML = r.inverters.map((i) => `<tr>
		<td><b>${esc(i.name)}</b></td><td>${nf(i.kwp)}</td><td>${kwh(i.energy_wh)}</td><td>${nf(i.specific_kwh_kwp)}</td>
		<td style="color:${i.performance != null && i.performance < 0.9 ? "var(--crit)" : "inherit"}">${i.performance == null ? "–" : Math.round(i.performance * 100) + " %"}</td>
		<td>${kwh(i.lost_wh)} · ${eur(i.lost_wh / 1000 * r.price)}</td><td>${i.alarms}</td></tr>`).join("")
		|| '<tr><td colspan="7" class="empty">Nessun inverter.</td></tr>';
}

$("report-pdf").onclick = async (e) => {
	e.preventDefault();
	const [year, month] = monthInput.value.split("-").map(Number);
	const btn = $("report-pdf"); btn.textContent = "Preparazione…";
	try {
		const res = await fetch(`/api/report/monthly.pdf?year=${year}&month=${month}`, { headers: { Authorization: "Bearer " + state.token } });
		if (!res.ok) throw new Error("Errore " + res.status);
		const url = URL.createObjectURL(await res.blob());
		const a = Object.assign(document.createElement("a"), { href: url, download: `report-${year}-${String(month).padStart(2, "0")}.pdf` });
		document.body.appendChild(a); a.click(); a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 10000);
	} catch (err) { alert("Impossibile generare il report: " + err.message); }
	btn.textContent = "Scarica PDF";
};

// ==== configurazione ==========================================
const getPath = (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj);
const setPath = (obj, path, v) => { const ks = path.split("."); const last = ks.pop(); ks.reduce((o, k) => o[k], obj)[last] = v; };

async function loadConfig() {
	try { state.config = await api("/api/config"); } catch (e) { return notice($("config-msg"), e.message, "err"); }
	document.querySelectorAll("[data-cfg]").forEach((el) => {
		const v = getPath(state.config, el.dataset.cfg);
		el.value = v == null ? "" : String(v);
	});
	renderDevices();
}

function renderDevices() {
	$("cfg-devices").innerHTML = state.config.devices.map((d, i) => `<tr data-i="${i}">
		<td><input data-k="name" value="${esc(d.name)}"></td>
		<td><select data-k="type"><option value="inverter" ${d.type === "inverter" ? "selected" : ""}>Inverter</option>
			<option value="irradiance" ${d.type === "irradiance" ? "selected" : ""}>Irraggiamento</option></select></td>
		<td><input data-k="host" value="${esc(d.host)}"></td>
		<td class="narrow"><input data-k="port" type="number" value="${d.port}"></td>
		<td class="narrow"><input data-k="unit_id" type="number" value="${d.unit_id}"></td>
		<td class="narrow"><input data-k="kwp" type="number" step="0.1" value="${d.kwp}" ${d.type === "inverter" ? "" : "disabled"}></td>
		<td style="white-space:nowrap"><button data-test="${i}">Prova</button> <button class="danger" data-del="${i}" title="Rimuovi">✕</button>
			<div class="small" data-result="${i}"></div></td></tr>`).join("")
		|| '<tr><td colspan="7" class="empty">Nessun dispositivo: aggiungi gli inverter dell\'impianto.</td></tr>';
	document.querySelectorAll("#cfg-devices [data-k]").forEach((el) => el.onchange = () => {
		const d = state.config.devices[+el.closest("tr").dataset.i];
		d[el.dataset.k] = el.type === "number" ? +el.value : el.value;
		if (el.dataset.k === "type") renderDevices();
	});
	document.querySelectorAll("[data-del]").forEach((b) => b.onclick = () => { state.config.devices.splice(+b.dataset.del, 1); renderDevices(); });
	document.querySelectorAll("[data-test]").forEach((b) => b.onclick = () => testDevice(+b.dataset.test));
}

async function testDevice(i) {
	const d = state.config.devices[i], out = document.querySelector(`[data-result="${i}"]`);
	out.textContent = "Connessione…"; out.style.color = "var(--muted)";
	try {
		const r = await api("/api/devices/test", { method: "POST", json: { type: d.type, host: d.host, port: d.port, unit_id: d.unit_id } });
		if (r.ok) {
			const info = [r.info.manufacturer, r.info.model, r.info.serial].filter(Boolean).join(" ");
			const val = d.type === "inverter" ? kw(r.values.ac_power_w) : (r.values.poa_wm2 ?? "–") + " W/m²";
			out.textContent = `✓ ${info} · ${val}`; out.style.color = "var(--ok)";
		} else { out.textContent = "✕ " + r.error; out.style.color = "var(--crit)"; }
	} catch (e) { out.textContent = "✕ " + e.message; out.style.color = "var(--crit)"; }
}

function nextUnit() { return Math.max(0, ...state.config.devices.map((d) => d.unit_id)) + 1; }
$("add-inverter").onclick = () => {
	const n = state.config.devices.filter((d) => d.type === "inverter").length + 1;
	state.config.devices.push({ name: `INV-${n}`, type: "inverter", host: "192.168.1.100", port: 502, unit_id: 1, kwp: 20 });
	renderDevices();
};
$("add-sensor").onclick = () => {
	state.config.devices.push({ name: "IRRAGGIAMENTO", type: "irradiance", host: "192.168.1.101", port: 502, unit_id: nextUnit(), kwp: 0 });
	renderDevices();
};
$("config-reload").onclick = loadConfig;
$("config-save").onclick = async () => {
	const cfg = structuredClone(state.config);
	document.querySelectorAll("[data-cfg]").forEach((el) => {
		let v = el.value;
		if (el.dataset.type === "bool") v = v === "true";
		else if (el.dataset.type === "optnum") v = v === "" ? null : +v;
		else if (el.type === "number") v = +v;
		setPath(cfg, el.dataset.cfg, v);
	});
	$("config-save").disabled = true;
	try {
		state.config = await api("/api/config", { method: "PUT", json: cfg });
		notice($("config-msg"), "Configurazione salvata e applicata.");
		renderDevices();
	} catch (e) { notice($("config-msg"), e.message, "err"); }
	$("config-save").disabled = false;
	window.scrollTo({ top: 0, behavior: "smooth" });
};

// ==== utenti ==================================================
async function loadUsers() {
	let r;
	try { r = await api("/api/users"); } catch (e) { return notice($("users-msg"), e.message, "err"); }
	const me = state.user;
	const canManage = (lvl) => me.level === 4 || lvl < me.level;
	const levelOpts = (sel) => Object.entries(r.levels).filter(([l]) => canManage(+l) || +l === sel)
		.map(([l, n]) => `<option value="${l}" ${+l === sel ? "selected" : ""} ${canManage(+l) ? "" : "disabled"}>${esc(n)}</option>`).join("");
	$("user-level").innerHTML = Object.entries(r.levels).filter(([l]) => canManage(+l))
		.map(([l, n]) => `<option value="${l}" ${+l === 1 ? "selected" : ""}>${esc(n)}</option>`).join("");
	$("users-list").innerHTML = r.users.map((u) => {
		const editable = u.id !== me.id && canManage(u.level);
		return `<tr data-id="${u.id}">
			<td><b>${esc(u.username)}</b>${u.id === me.id ? ' <span class="small muted">(tu)</span>' : ""}${u.must_change_password ? '<div class="small muted">deve cambiare password</div>' : ""}</td>
			<td>${editable ? `<input data-f="description" value="${esc(u.description)}">` : esc(u.description)}</td>
			<td>${editable ? `<select data-f="level">${levelOpts(u.level)}</select>` : esc(u.level_name)}</td>
			<td style="white-space:nowrap">${editable ? `<button data-save>Salva</button> <button data-reset>Nuova password</button> <button class="danger" data-remove>Elimina</button>` : ""}</td></tr>`;
	}).join("");
	document.querySelectorAll("#users-list tr").forEach((tr) => {
		const id = tr.dataset.id, q = (s) => tr.querySelector(s);
		const run = async (fn, okMsg) => { try { await fn(); notice($("users-msg"), okMsg); loadUsers(); } catch (e) { notice($("users-msg"), e.message, "err"); } };
		if (q("[data-save]")) q("[data-save]").onclick = () => run(() => api(`/api/users/${id}`, { method: "PUT",
			json: { description: q('[data-f="description"]').value, level: +q('[data-f="level"]').value } }), "Utente aggiornato.");
		if (q("[data-reset]")) q("[data-reset]").onclick = () => {
			const pw = prompt("Nuova password temporanea (almeno 6 caratteri). L'utente dovrà cambiarla al prossimo accesso:");
			if (pw) run(() => api(`/api/users/${id}`, { method: "PUT", json: { password: pw } }), "Password reimpostata.");
		};
		if (q("[data-remove]")) q("[data-remove]").onclick = () => {
			if (confirm("Eliminare l'utente " + tr.querySelector("b").textContent + "?"))
				run(() => api(`/api/users/${id}`, { method: "DELETE" }), "Utente eliminato.");
		};
	});
}

$("user-form").onsubmit = async (e) => {
	e.preventDefault();
	const f = new FormData(e.target);
	try {
		await api("/api/users", { method: "POST", json: { username: f.get("username"), description: f.get("description"), level: +f.get("level"), password: f.get("password") } });
		e.target.reset(); notice($("users-msg"), "Utente creato."); loadUsers();
	} catch (err) { notice($("users-msg"), err.message, "err"); }
};

boot();
