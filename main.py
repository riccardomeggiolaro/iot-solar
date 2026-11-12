"""
IoT-Solar: monitoraggio impianti fotovoltaici.

Avvia (nello stesso processo asyncio):
  - il simulatore Modbus SunSpec, se abilitato in config;
  - il ciclo di monitoraggio (lettura, storico, analisi, allarmi);
  - l'API REST con la dashboard.

Uso:  python main.py [percorso/config.json]
"""
import asyncio
import json
import logging
import os
import signal
import sys
from pathlib import Path

import uvicorn

from applications.app_api import create_app
from modules.md_database.database import Database
from modules.md_monitor.monitor import Monitor

BASE = Path(__file__).parent


def load_config(path=None):
	path = Path(path or os.environ.get("IOT_SOLAR_CONFIG") or BASE / "config.json")
	if not path.exists():
		path = BASE / "config.example.json"
	with open(path, encoding="utf-8") as f:
		return json.load(f), path


async def main(config_path=None):
	config, path = load_config(config_path)
	logging.basicConfig(level=config.get("log_level", "INFO"),
						format="%(asctime)s %(levelname)-7s %(name)-10s %(message)s")
	logging.getLogger("pymodbus").setLevel(logging.CRITICAL)
	logging.info("configurazione: %s", path)

	stop = asyncio.Event()
	loop = asyncio.get_running_loop()
	for sig in (signal.SIGINT, signal.SIGTERM):
		try:
			loop.add_signal_handler(sig, stop.set)
		except NotImplementedError:
			pass

	db_path = config.get("database", {}).get("path", "data/iot-solar.db")
	db = Database(db_path if os.path.isabs(db_path) else str(BASE / db_path))
	tasks = []

	simulator = None
	if config.get("simulator", {}).get("enabled"):
		from modules.md_simulator.simulator import PlantSimulator
		simulator = PlantSimulator(config)
		tasks.append(asyncio.create_task(simulator.run(stop)))
		await asyncio.sleep(0.5)

	monitor = Monitor(config, db)
	tasks.append(asyncio.create_task(monitor.run(stop)))

	api = config.get("api", {})
	server = uvicorn.Server(uvicorn.Config(create_app(monitor, simulator), host=api.get("host", "0.0.0.0"),
										   port=api.get("port", 8080), log_level="warning"))
	server.install_signal_handlers = lambda: None
	tasks.append(asyncio.create_task(server.serve()))
	logging.info("dashboard: http://%s:%s", api.get("host", "0.0.0.0"), api.get("port", 8080))

	await stop.wait()
	server.should_exit = True
	await asyncio.gather(*tasks, return_exceptions=True)
	db.close()


if __name__ == "__main__":
	asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else None))
