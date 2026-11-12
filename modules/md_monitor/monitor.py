"""
Ciclo principale: legge tutti i dispositivi, salva le misure, esegue l'analisi
e aggiorna gli allarmi. Mantiene l'ultimo stato per l'API.
"""
import asyncio
import logging
import time
from datetime import datetime
from zoneinfo import ZoneInfo

from modules.md_alarms.alarms import AlarmManager
from modules.md_analysis.analyzer import analyze
from modules.md_inverter.reader import Device, ReadError, SunSpecReader

log = logging.getLogger("monitor")


class Monitor:
	def __init__(self, config, db):
		self.config = config
		self.db = db
		self.tz = ZoneInfo(config["plant"].get("timezone", "Europe/Rome"))
		self.interval = config.get("polling", {}).get("interval_s", 5)
		self.retention_days = config.get("database", {}).get("retention_days", 400)
		self.analysis_settings = config.get("analysis", {})
		self.devices = [Device(name=d["name"], type=d["type"], host=d["host"], port=d.get("port", 502),
							   unit_id=d.get("unit_id", 1), kwp=d.get("kwp", 0.0)) for d in config["devices"]]
		self.reader = SunSpecReader(timeout=config.get("polling", {}).get("timeout_s", 3))
		self.alarms = AlarmManager(db, {**config.get("alarms", {}), **self.analysis_settings})
		self.last = {"ts": None, "readings": {}, "expected": {}, "summary": {}}
		self._last_cycle = None

	async def _read_one(self, dev):
		try:
			values = await self.reader.read(dev)
			dev.failures = 0
			return values
		except (ReadError, OSError) as e:
			dev.failures += 1
			if dev.failures == 1:
				log.warning("lettura fallita %s: %s", dev.name, e)
			self.reader.invalidate(dev)
			return None

	async def cycle(self):
		now = time.time()
		dt = (now - self._last_cycle) if self._last_cycle else self.interval
		self._last_cycle = now
		results = await asyncio.gather(*(self._read_one(d) for d in self.devices))
		readings = {d.name: r for d, r in zip(self.devices, results)}
		expected, conditions, summary = analyze(self.devices, readings, self.analysis_settings)
		poa = summary.get("poa_wm2")
		for d in self.devices:
			r = readings[d.name]
			if r is None:
				continue
			if d.type == "inverter":
				self.db.insert_reading(d.name, {**r, "status": r.get("status_text"), "poa_wm2": poa,
												"expected_w": expected.get(d.name)}, ts=now)
			else:
				self.db.insert_reading(d.name, {"poa_wm2": r.get("poa_wm2")}, ts=now)
		await self.alarms.process(conditions, dt, now)
		self.last = {"ts": now, "readings": readings, "expected": expected, "summary": summary}

	def start_of_day(self):
		return datetime.now(self.tz).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()

	def snapshot(self):
		"""Stato corrente dell'impianto per la dashboard."""
		price = self.config["plant"].get("energy_price_eur_kwh", 0.2)
		stats = self.db.energy_stats(self.start_of_day(), devices=[d.name for d in self.devices if d.type == "inverter"])
		devices, total_w, total_exp, energy_today, lost_today = [], 0.0, 0.0, 0.0, 0.0
		for d in self.devices:
			r = self.last["readings"].get(d.name)
			item = {"name": d.name, "type": d.type, "kwp": d.kwp, "online": d.failures == 0 and r is not None,
					"info": d.info, "values": r}
			if d.type == "inverter":
				exp = self.last["expected"].get(d.name)
				st = stats.get(d.name, {})
				e_today, l_today = st.get("energy_wh", 0.0), st.get("lost_wh", 0.0)
				item.update(expected_w=exp, energy_today_wh=e_today, lost_today_wh=l_today)
				total_w += (r or {}).get("ac_power_w") or 0
				total_exp += exp or 0
				energy_today += e_today
				lost_today += l_today
			devices.append(item)
		return {
			"plant": self.config["plant"]["name"],
			"ts": self.last["ts"],
			"kwp": sum(d.kwp for d in self.devices if d.type == "inverter"),
			"power_w": total_w,
			"expected_w": total_exp,
			"poa_wm2": self.last["summary"].get("poa_wm2"),
			"energy_today_wh": energy_today,
			"lost_today_wh": lost_today,
			"lost_today_eur": lost_today / 1000 * price,
			"energy_price_eur_kwh": price,
			"devices": devices,
			"active_alarms": self.db.active_alarms(),
		}

	async def run(self, stop_event=None):
		log.info("monitoraggio avviato: %d dispositivi, intervallo %ss", len(self.devices), self.interval)
		last_purge = 0
		while not (stop_event and stop_event.is_set()):
			started = time.monotonic()
			try:
				await self.cycle()
			except Exception:
				log.exception("errore nel ciclo di monitoraggio")
			if time.time() - last_purge > 3600:
				self.db.purge_before(time.time() - self.retention_days * 86400)
				last_purge = time.time()
			await asyncio.sleep(max(0.0, self.interval - (time.monotonic() - started)))
		self.reader.close()
