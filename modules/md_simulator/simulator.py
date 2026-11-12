"""
Simulatore di impianto fotovoltaico: espone via Modbus TCP più inverter SunSpec
(modello 1 + 103) e un sensore di irraggiamento (modello 302), ognuno su un unit id.

- Il sole segue la posizione reale per latitudine/longitudine configurate.
- `speed` accelera il tempo solare (60 = un'ora di sole al minuto) per le demo.
- Nuvole: fattore comune che varia lentamente.
- Guasti iniettabili per inverter: sporco, stringa persa, stato FAULT, offline.
"""
import asyncio
import logging
import random
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from time import monotonic
from zoneinfo import ZoneInfo

from pymodbus.datastore import ModbusSequentialDataBlock, ModbusServerContext, ModbusSlaveContext
from pymodbus.server import StartAsyncTcpServer

from modules.md_analysis import solar
from modules.md_sunspec import sunspec

log = logging.getLogger("simulator")

BASE = sunspec.BASE_ADDRESSES[0]
SIM_DERATE = 0.95        # perdite cavi/mismatch dell'impianto simulato
INVERTER_EFFICIENCY = 0.97


@dataclass
class SimInverter:
	unit_id: int
	name: str
	kwp: float
	serial: str
	soiling: float = 0.0       # 0..1 frazione di produzione persa per sporco
	string_loss: float = 0.0   # 0..1 frazione di stringhe fuori servizio
	fault: bool = False
	offline: bool = False
	energy_wh: float = field(default_factory=lambda: random.uniform(1e6, 5e6))

	@property
	def ac_limit_w(self):
		return self.kwp * 1000 * 0.9


@dataclass
class SimSensor:
	unit_id: int
	name: str
	offline: bool = False


class PlantSimulator:
	def __init__(self, config):
		plant = config["plant"]
		sim = config.get("simulator", {})
		self.lat = plant["latitude"]
		self.lon = plant["longitude"]
		self.tz = ZoneInfo(plant.get("timezone", "Europe/Rome"))
		self.host = sim.get("host", "127.0.0.1")
		self.port = sim.get("port", 5020)
		self.speed = float(sim.get("speed", 1))
		self.clouds_enabled = sim.get("clouds", True)
		self.ambient_c = sim.get("ambient_c", 22.0)
		start_hour = sim.get("start_hour")
		now = datetime.now(self.tz)
		self._sim_start = now.replace(hour=int(start_hour), minute=0, second=0, microsecond=0) if start_hour is not None else now
		self._t0 = monotonic()
		self._last_tick = monotonic()
		self.cloud = 1.0
		self.inverters = {}
		self.sensors = {}
		for dev in config["devices"]:
			if dev["type"] == "inverter":
				self.inverters[dev["name"]] = SimInverter(dev["unit_id"], dev["name"], dev["kwp"], f"SIM-{dev['unit_id']:04d}")
			elif dev["type"] == "irradiance":
				self.sensors[dev["name"]] = SimSensor(dev["unit_id"], dev["name"])
		self._slaves = {}
		for unit in [i.unit_id for i in self.inverters.values()] + [s.unit_id for s in self.sensors.values()]:
			self._slaves[unit] = ModbusSlaveContext(hr=ModbusSequentialDataBlock(0, [0] * (BASE + 300)))
		self.context = ModbusServerContext(slaves=dict(self._slaves), single=False)
		self.state = {}

	# ---- tempo e meteo ------------------------------------------------
	def sim_now(self):
		return self._sim_start + timedelta(seconds=(monotonic() - self._t0) * self.speed)

	def _update_clouds(self, dt):
		if not self.clouds_enabled:
			self.cloud = 1.0
			return
		# random walk lenta con ritorno verso il sereno
		self.cloud += random.gauss(0, 0.04) * dt ** 0.5 + (0.95 - self.cloud) * 0.02 * dt
		self.cloud = min(1.0, max(0.25, self.cloud))

	# ---- controllo guasti (usato da API e test) -----------------------
	def set_fault(self, name, **kwargs):
		target = self.inverters.get(name) or self.sensors.get(name)
		if target is None:
			raise KeyError(name)
		for key, value in kwargs.items():
			if value is not None and hasattr(target, key):
				setattr(target, key, value)
		self._apply_offline(target)
		return self.describe()[name]

	def _apply_offline(self, target):
		if target.offline:
			try:
				del self.context[target.unit_id]
			except Exception:
				pass
		else:
			self.context[target.unit_id] = self._slaves[target.unit_id]

	def describe(self):
		out = {}
		for inv in self.inverters.values():
			out[inv.name] = {"type": "inverter", "unit_id": inv.unit_id, "kwp": inv.kwp, "soiling": inv.soiling,
							 "string_loss": inv.string_loss, "fault": inv.fault, "offline": inv.offline}
		for s in self.sensors.values():
			out[s.name] = {"type": "irradiance", "unit_id": s.unit_id, "offline": s.offline}
		return out

	# ---- aggiornamento registri ---------------------------------------
	def tick(self):
		t = monotonic()
		dt = min(t - self._last_tick, 10.0)
		self._last_tick = t
		self._update_clouds(dt)
		when = self.sim_now()
		elev = solar.sun_elevation_deg(self.lat, self.lon, when)
		ghi = solar.clear_sky_ghi(elev) * self.cloud
		poa = solar.approx_poa(ghi, elev)
		t_cell = solar.cell_temperature(self.ambient_c, poa)
		self.state = {"sim_time": when.isoformat(timespec="seconds"), "sun_elevation": round(elev, 1),
					  "ghi": round(ghi), "poa": round(poa), "cloud_factor": round(self.cloud, 2)}

		for s in self.sensors.values():
			regs = sunspec.build_image(sunspec.encode_common("SimSolar", "IRR-302", "1.0", f"IRR-{s.unit_id:04d}", s.unit_id),
									   sunspec.encode_irradiance(ghi, poa))
			self._slaves[s.unit_id].setValues(3, BASE, regs)

		for inv in self.inverters.values():
			dc_w = inv.kwp * poa * SIM_DERATE * (1 + solar.DEFAULT_TEMP_COEFF * (t_cell - 25))
			dc_w *= (1 - inv.soiling) * (1 - inv.string_loss)
			dc_w = max(dc_w, 0.0) * random.uniform(0.99, 1.01)
			if inv.fault:
				status, ac_w, dc_w, events = sunspec.STATE_FAULT, 0.0, 0.0, 0x0001
			elif poa < 5:
				status, ac_w, dc_w, events = sunspec.STATE_SLEEPING, 0.0, 0.0, 0
			else:
				status, events = sunspec.STATE_MPPT, 0
				ac_w = dc_w * INVERTER_EFFICIENCY
				if ac_w > inv.ac_limit_w:
					ac_w, status = inv.ac_limit_w, 5  # THROTTLED
			inv.energy_wh += ac_w * dt / 3600
			dc_v = (620 - (t_cell - 25) * 1.8) if dc_w > 0 else 0.0
			dc_v *= 1.0 if inv.string_loss < 1 else 0
			dc_a = dc_w / dc_v if dc_v else 0.0
			temp = self.ambient_c + 5 + 30 * (ac_w / (inv.kwp * 1000)) if inv.kwp else self.ambient_c
			regs = sunspec.build_image(
				sunspec.encode_common("SimSolar", "SIM-INV-3PH", "2.1.0", inv.serial, inv.unit_id),
				sunspec.encode_inverter(ac_w, inv.energy_wh, dc_v, dc_a, dc_w, ac_voltage_v=230 + random.uniform(-2, 2),
										frequency_hz=50 + random.uniform(-0.02, 0.02), temperature_c=temp,
										status=status, events=events))
			self._slaves[inv.unit_id].setValues(3, BASE, regs)

	async def run(self, stop_event=None):
		self.tick()
		server = asyncio.create_task(StartAsyncTcpServer(context=self.context, address=(self.host, self.port), ignore_missing_slaves=True))
		log.info("simulatore Modbus avviato su %s:%s (velocità x%s)", self.host, self.port, self.speed)
		try:
			while not (stop_event and stop_event.is_set()):
				await asyncio.sleep(1)
				self.tick()
		finally:
			server.cancel()
