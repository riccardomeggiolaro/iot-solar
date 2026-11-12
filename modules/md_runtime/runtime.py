"""
Runtime dell'applicazione: tiene insieme configurazione, database, autenticazione,
simulatore e monitor, e permette di applicare una nuova configurazione dal web
senza riavviare il processo.
"""
import asyncio
import logging
import os
from pathlib import Path

from modules.md_auth.auth import Auth, load_secret_key
from modules.md_database.database import Database
from modules.md_monitor.monitor import Monitor
from modules.md_runtime import settings

log = logging.getLogger("runtime")
VERSION_FILE = settings.BASE / "VERSION"


def app_version():
	env = os.environ.get("IOT_SOLAR_VERSION")
	if env:
		return env
	return VERSION_FILE.read_text().strip() if VERSION_FILE.exists() else "dev"


class Runtime:
	def __init__(self, config_path, data_dir, db=None):
		self.config_path = Path(config_path)
		self.data_dir = Path(data_dir)
		self.data_dir.mkdir(parents=True, exist_ok=True)
		self.config = settings.load_config(self.config_path)
		self.version = app_version()
		self.db = db or Database(str(self.data_dir / "iot-solar.db"))
		self.auth = Auth(self.db, load_secret_key(self.data_dir), self.config["api"]["token_hours"])
		self.monitor = None
		self.simulator = None
		self.running = False
		self._tasks = []
		self._stop = None
		self._lock = asyncio.Lock()
		self._build()

	def _build(self):
		self.monitor = Monitor(self.config, self.db)
		self.simulator = None
		if self.config["simulator"]["enabled"]:
			from modules.md_simulator.simulator import PlantSimulator
			self.simulator = PlantSimulator(self.config)

	async def start(self):
		self.running = True
		self._stop = asyncio.Event()
		if self.simulator:
			self._tasks.append(asyncio.create_task(self.simulator.run(self._stop)))
			await asyncio.sleep(0.3)
		self._tasks.append(asyncio.create_task(self.monitor.run(self._stop)))

	async def stop(self):
		if self._stop:
			self._stop.set()
		if self._tasks:
			await asyncio.gather(*self._tasks, return_exceptions=True)
		self._tasks = []

	async def apply_config(self, new_config):
		"""Valida, salva su disco e riavvia monitor e simulatore con la nuova configurazione."""
		config = settings.validate(new_config)
		async with self._lock:
			settings.save_config(self.config_path, config)
			was_running = self.running
			if was_running:
				await self.stop()
			self.config = config
			self.auth.token_hours = config["api"]["token_hours"]
			self._build()
			if was_running:
				await self.start()
		log.info("configurazione aggiornata: %d dispositivi, simulatore %s",
				 len(config["devices"]), "attivo" if config["simulator"]["enabled"] else "spento")
		return config

	async def shutdown(self):
		await self.stop()
		self.running = False
		self.db.close()
