"""API REST e dashboard web."""
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

STATIC = Path(__file__).parent / "static"


class FaultRequest(BaseModel):
	soiling: float | None = Field(None, ge=0, le=1)
	string_loss: float | None = Field(None, ge=0, le=1)
	fault: bool | None = None
	offline: bool | None = None


def create_app(monitor, simulator=None):
	app = FastAPI(title="IoT-Solar", version="0.1.0")

	@app.get("/", include_in_schema=False)
	async def index():
		return FileResponse(STATIC / "index.html")

	@app.get("/api/plant")
	async def plant():
		return monitor.snapshot()

	@app.get("/api/devices/{name}/history")
	async def history(name: str, hours: float = 24):
		if name not in {d.name for d in monitor.devices}:
			raise HTTPException(404, "dispositivo sconosciuto")
		return monitor.db.history(name, time.time() - hours * 3600)

	@app.get("/api/alarms")
	async def alarms(active: bool = False, limit: int = 100):
		return monitor.db.active_alarms() if active else monitor.db.alarms(limit)

	@app.post("/api/alarms/{alarm_id}/ack")
	async def ack(alarm_id: int):
		if not monitor.db.acknowledge_alarm(alarm_id):
			raise HTTPException(404, "allarme non trovato")
		return {"ok": True}

	@app.get("/api/simulator")
	async def sim_state():
		if simulator is None:
			raise HTTPException(404, "simulatore non attivo")
		return {"state": simulator.state, "devices": simulator.describe()}

	@app.post("/api/simulator/{name}")
	async def sim_fault(name: str, req: FaultRequest):
		if simulator is None:
			raise HTTPException(404, "simulatore non attivo")
		try:
			return simulator.set_fault(name, **req.model_dump())
		except KeyError:
			raise HTTPException(404, "dispositivo sconosciuto")

	app.mount("/static", StaticFiles(directory=STATIC), name="static")
	return app
