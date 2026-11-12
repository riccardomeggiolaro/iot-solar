"""
Gestione allarmi: trasforma le condizioni dell'analizzatore in allarmi persistenti,
con isteresi (un'anomalia deve durare N cicli prima di aprire l'allarme e sparire
per N cicli prima di chiuderlo) e conteggio dell'energia persa.
"""
import logging
import time

import httpx

log = logging.getLogger("alarms")

# cicli consecutivi prima di aprire; i guasti gravi aprono subito
OPEN_CYCLES = {"OFFLINE": 1, "FAULT": 1}
DEFAULT_OPEN_CYCLES = 6
CLOSE_CYCLES = 3


class AlarmManager:
	def __init__(self, db, settings=None):
		self.db = db
		settings = settings or {}
		self.open_cycles = settings.get("persist_cycles", DEFAULT_OPEN_CYCLES)
		self.webhook_url = settings.get("webhook_url") or None
		self._counters = {}   # (device, code) -> cicli consecutivi in anomalia (>0) o normali (<0)
		self._open = {}       # (device, code) -> id allarme
		for a in db.active_alarms():
			self._open[(a["device"], a["code"])] = a["id"]
		self._lost = {k: 0.0 for k in self._open}

	async def process(self, conditions, dt_s, now=None):
		now = now or time.time()
		events = []
		for c in conditions:
			key = (c.device, c.code)
			if c.active is None:
				continue
			n = self._counters.get(key, 0)
			n = max(n, 0) + 1 if c.active else min(n, 0) - 1
			self._counters[key] = n

			if c.active and key in self._open:
				if c.deficit_w:
					self._lost[key] = self._lost.get(key, 0.0) + c.deficit_w * dt_s / 3600
					self.db.update_alarm(self._open[key], message=c.message, lost_wh=self._lost[key])
			elif c.active and n >= OPEN_CYCLES.get(c.code, self.open_cycles):
				alarm_id = self.db.open_alarm(c.device, c.code, c.severity, c.message, c.hint, now)
				self._open[key] = alarm_id
				self._lost[key] = 0.0
				events.append(("open", c))
				log.warning("ALLARME %s %s: %s", c.device, c.code, c.message)
			elif not c.active and key in self._open and -n >= CLOSE_CYCLES:
				self.db.close_alarm(self._open.pop(key), now)
				self._lost.pop(key, None)
				events.append(("close", c))
				log.info("rientrato %s %s", c.device, c.code)

		if self.webhook_url and events:
			await self._notify(events)
		return events

	async def _notify(self, events):
		payload = [{"event": kind, "device": c.device, "code": c.code, "severity": c.severity,
					"message": c.message, "hint": c.hint} for kind, c in events]
		try:
			async with httpx.AsyncClient(timeout=5) as client:
				await client.post(self.webhook_url, json={"alarms": payload})
		except Exception as e:
			log.error("webhook non raggiungibile: %s", e)
