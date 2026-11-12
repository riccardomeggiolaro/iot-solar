"""
KINETRA Energia (iot-solar): monitoraggio impianti fotovoltaici.

Avvia nello stesso processo asyncio il simulatore (se abilitato), il ciclo di
monitoraggio e l'API REST con la dashboard.

Cartelle (variabili d'ambiente, usate da Docker):
  IOT_SOLAR_CONFIG_DIR   contiene config.json (creato dall'esempio al primo avvio)
  IOT_SOLAR_DATA_DIR     database, chiave dei token
  IOT_SOLAR_ADMIN_PASSWORD  password iniziale dell'utente admin (solo al primo avvio)

Uso:  python main.py [percorso/config.json]
"""
import asyncio
import logging
import os
import signal
import sys

import uvicorn

from applications.app_api import create_app
from modules.md_runtime import settings
from modules.md_runtime.runtime import Runtime


async def main(config_path=None):
	default_config, data_dir = settings.resolve_paths()
	runtime = Runtime(config_path or default_config, data_dir)
	config = runtime.config
	logging.basicConfig(level=config.get("log_level", "INFO"),
						format="%(asctime)s %(levelname)-7s %(name)-10s %(message)s")
	logging.getLogger("pymodbus").setLevel(logging.CRITICAL)
	logging.info("KINETRA Energia %s – configurazione %s, dati %s", runtime.version, runtime.config_path, runtime.data_dir)

	initial = runtime.auth.ensure_admin(os.environ.get("IOT_SOLAR_ADMIN_PASSWORD"))
	if initial:
		logging.warning("primo accesso: utente 'admin', password %s",
						"quella impostata in IOT_SOLAR_ADMIN_PASSWORD" if os.environ.get("IOT_SOLAR_ADMIN_PASSWORD") else "'admin'")

	stop = asyncio.Event()
	loop = asyncio.get_running_loop()
	for sig in (signal.SIGINT, signal.SIGTERM):
		try:
			loop.add_signal_handler(sig, stop.set)
		except NotImplementedError:
			pass

	await runtime.start()
	api = config["api"]
	server = uvicorn.Server(uvicorn.Config(create_app(runtime), host=api["host"], port=api["port"], log_level="warning"))
	server.install_signal_handlers = lambda: None
	serve = asyncio.create_task(server.serve())
	logging.info("dashboard: http://%s:%s", "localhost" if api["host"] == "0.0.0.0" else api["host"], api["port"])

	await stop.wait()
	server.should_exit = True
	await asyncio.gather(serve, return_exceptions=True)
	await runtime.shutdown()


if __name__ == "__main__":
	asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else None))
