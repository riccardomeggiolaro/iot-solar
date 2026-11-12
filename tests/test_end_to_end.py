"""Simulatore Modbus reale + lettore + monitor, senza API."""
import asyncio
import socket

from modules.md_database.database import Database
from modules.md_monitor.monitor import Monitor
from modules.md_simulator.simulator import PlantSimulator


def free_port():
	with socket.socket() as s:
		s.bind(("127.0.0.1", 0))
		return s.getsockname()[1]


def make_config(port):
	dev = lambda name, unit, kind="inverter": {"name": name, "type": kind, "host": "127.0.0.1", "port": port, "unit_id": unit, "kwp": 40}
	return {
		"plant": {"name": "test", "latitude": 45.4, "longitude": 11.9, "timezone": "Europe/Rome"},
		"polling": {"interval_s": 0.2, "timeout_s": 0.5},
		"devices": [dev("I1", 1), dev("I2", 2), dev("I3", 3), dev("IRR", 9, "irradiance")],
		"analysis": {"persist_cycles": 2, "offline_after_failures": 2},
		"simulator": {"host": "127.0.0.1", "port": port, "start_hour": 12, "clouds": False},
	}


def test_simulator_monitor_detects_faults():
	async def scenario():
		config = make_config(free_port())
		sim = PlantSimulator(config)
		stop = asyncio.Event()
		sim_task = asyncio.create_task(sim.run(stop))
		await asyncio.sleep(0.5)
		monitor = Monitor(config, Database(":memory:"))

		for _ in range(2):
			await monitor.cycle()
		snap = monitor.snapshot()
		assert all(d["online"] for d in snap["devices"])
		assert snap["devices"][0]["info"]["serial"] == "SIM-0001"
		assert snap["power_w"] > 0 and snap["active_alarms"] == []

		sim.set_fault("I2", string_loss=0.5)
		sim.set_fault("I3", offline=True)
		for _ in range(4):
			sim.tick()
			await monitor.cycle()
		active = {(a["device"], a["code"]) for a in monitor.db.active_alarms()}
		assert ("I3", "OFFLINE") in active
		assert ("I2", "UNDERPERF_EXPECTED") in active
		assert all(dev != "I1" for dev, _ in active)

		stop.set()
		monitor.reader.close()
		await asyncio.wait_for(sim_task, 3)

	asyncio.run(scenario())
