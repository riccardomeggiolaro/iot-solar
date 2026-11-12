"""
Analisi delle prestazioni: calcola la produzione attesa di ogni inverter e
individua le anomalie.

Due confronti indipendenti:
1. contro il sensore di irraggiamento (se presente): potenza attesa dal modello fisico;
2. tra inverter "pari" (stessi kWp normalizzati): chi produce molto meno della mediana
   ha un problema suo (stringa, ombra, sporco locale), anche senza sensore e con nuvole.

Ogni condizione ha tre esiti: True (anomalia), False (tutto ok), None (non valutabile,
es. di notte): lo stato None non apre e non chiude gli allarmi.
"""
from dataclasses import dataclass
from statistics import median

from modules.md_analysis import solar
from modules.md_sunspec import sunspec

DEFAULTS = {
	"derate": 0.85,                # rapporto tra potenza AC reale e kWp*POA/1000 di un impianto sano
	"min_irradiance": 150,         # W/m2 sotto cui non si valuta il rendimento
	"min_specific_power": 0.08,    # kW/kWp mediano minimo per il confronto tra pari
	"peer_threshold": 0.15,        # scostamento dalla mediana dei pari
	"expected_threshold": 0.20,    # scostamento dall'atteso da sensore
	"overtemp_c": 75,
	"offline_after_failures": 3,
}


@dataclass
class Condition:
	device: str
	code: str
	active: bool | None
	severity: str = "warning"
	message: str = ""
	hint: str = ""
	deficit_w: float = 0.0


def _hint_for_deficit(deviation):
	if deviation >= 0.9:
		return "Produzione quasi nulla: controllare sezionatori DC, fusibili di stringa e stato inverter."
	if deviation >= 0.35:
		return "Possibile stringa o MPPT fuori servizio: verificare tensione e corrente delle singole stringhe."
	return "Possibile sporco, ombreggiamento o degrado dei moduli: pianificare ispezione/pulizia."


def analyze(devices, readings, settings=None):
	"""
	devices: lista di Device (reader); readings: nome -> dict letto o None se in errore.
	Restituisce (expected_w per inverter, lista di Condition, riepilogo).
	"""
	cfg = {**DEFAULTS, **(settings or {})}
	inverters = [d for d in devices if d.type == "inverter"]
	sensors = [d for d in devices if d.type == "irradiance"]
	conditions, expected = [], {}

	# --- comunicazione -------------------------------------------------
	for d in devices:
		offline = d.failures >= cfg["offline_after_failures"]
		conditions.append(Condition(d.name, "OFFLINE", offline, "critical",
									f"{d.name} non risponde da {d.failures} letture",
									"Verificare alimentazione, rete/RS485 e indirizzo Modbus del dispositivo."))

	poa_values = [readings[s.name]["poa_wm2"] for s in sensors if readings.get(s.name) and readings[s.name].get("poa_wm2") is not None]
	poa = median(poa_values) if poa_values else None

	# --- stato e temperatura -------------------------------------------
	producing = {}
	for d in inverters:
		r = readings.get(d.name)
		if not r:
			continue
		fault = r.get("status") == sunspec.STATE_FAULT
		conditions.append(Condition(d.name, "FAULT", fault, "critical",
									f"{d.name} in stato FAULT (eventi 0x{r.get('events', 0):08X})",
									"Leggere il codice errore sul display/portale dell'inverter e intervenire."))
		temp = r.get("temperature_c")
		conditions.append(Condition(d.name, "OVERTEMP", None if temp is None else temp > cfg["overtemp_c"], "warning",
									f"{d.name} temperatura {temp:.0f} °C" if temp is not None else "",
									"Controllare ventilazione e filtri del locale inverter."))
		if not fault and d.kwp and r.get("ac_power_w") is not None:
			producing[d.name] = r["ac_power_w"] / 1000 / d.kwp  # kW/kWp

	# --- confronto tra pari --------------------------------------------
	peer_median = median(producing.values()) if len(producing) >= 3 else None
	peer_ok = peer_median is not None and peer_median >= cfg["min_specific_power"]

	# --- confronto con l'atteso ----------------------------------------
	sensor_ok = poa is not None and poa >= cfg["min_irradiance"]
	below_expected = []
	for d in inverters:
		r = readings.get(d.name)
		if not r or d.name not in producing:
			if r and r.get("status") == sunspec.STATE_FAULT:
				if sensor_ok:
					expected[d.name] = solar.expected_ac_power(d.kwp, poa, cfg["derate"])
				elif peer_ok:
					expected[d.name] = peer_median * d.kwp * 1000
			continue
		actual = r["ac_power_w"]
		throttled = r.get("status") == 5
		if poa is not None:
			expected[d.name] = solar.expected_ac_power(d.kwp, poa, cfg["derate"])
		elif peer_median is not None:
			expected[d.name] = peer_median * d.kwp * 1000

		# vs sensore
		if sensor_ok and not throttled and expected.get(d.name):
			dev_exp = 1 - actual / expected[d.name]
			is_low = dev_exp > cfg["expected_threshold"]
			if is_low:
				below_expected.append(d.name)
			conditions.append(Condition(d.name, "UNDERPERF_EXPECTED", is_low, "warning",
										f"{d.name} produce {actual / 1000:.1f} kW, atteso {expected[d.name] / 1000:.1f} kW (-{dev_exp:.0%})",
										_hint_for_deficit(dev_exp), max(expected[d.name] - actual, 0)))
		else:
			conditions.append(Condition(d.name, "UNDERPERF_EXPECTED", None))

		# vs pari
		if peer_ok and not throttled:
			dev_peer = 1 - producing[d.name] / peer_median
			is_low = dev_peer > cfg["peer_threshold"]
			conditions.append(Condition(d.name, "UNDERPERF_PEER", is_low, "warning",
										f"{d.name} rende il {dev_peer:.0%} in meno degli altri inverter",
										_hint_for_deficit(dev_peer), max(peer_median * d.kwp * 1000 - actual, 0)))
		else:
			conditions.append(Condition(d.name, "UNDERPERF_PEER", None))

	# un inverter in FAULT perde tutta la produzione attesa
	for c in conditions:
		if c.code == "FAULT" and c.active:
			c.deficit_w = expected.get(c.device, 0.0)

	# --- diagnosi a livello di impianto --------------------------------
	plant_low = None
	if sensor_ok and len(producing) >= 2:
		plant_low = len(below_expected) == len(producing)
	conditions.append(Condition("IMPIANTO", "PLANT_UNDERPERF", plant_low, "warning",
								"Tutti gli inverter producono meno dell'atteso",
								"Calo uniforme: probabile sporco generalizzato, oppure sensore di irraggiamento sporco o da ricalibrare."))

	summary = {"poa_wm2": poa, "peer_median_kw_per_kwp": peer_median}
	return expected, conditions, summary
