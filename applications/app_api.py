"""API REST e dashboard web."""
import time
from datetime import datetime
from zoneinfo import ZoneInfo
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError

from modules.md_analysis import solar
from modules.md_auth.auth import (LEVEL_ADMIN, LEVEL_NAMES, LEVEL_READONLY, LEVEL_USER, AuthError, public_user)
from modules.md_inverter.reader import Device, ReadError, SunSpecReader
from modules.md_report.report import MONTHS, month_data, build_pdf

STATIC = Path(__file__).parent / "static"


class LoginRequest(BaseModel):
	username: str
	password: str


class PasswordRequest(BaseModel):
	old_password: str
	new_password: str


class UserCreate(BaseModel):
	username: str = Field(min_length=1, max_length=40)
	password: str
	level: int
	description: str = ""


class UserUpdate(BaseModel):
	description: str | None = None
	level: int | None = None
	password: str | None = None


class FaultRequest(BaseModel):
	soiling: float | None = Field(None, ge=0, le=1)
	string_loss: float | None = Field(None, ge=0, le=1)
	fault: bool | None = None
	offline: bool | None = None


class DeviceTest(BaseModel):
	type: str = "inverter"
	host: str
	port: int = 502
	unit_id: int = 1


def _validation_message(e: ValidationError):
	parts = []
	for err in e.errors():
		loc = ".".join(str(x) for x in err["loc"] if x != "__root__")
		msg = err["msg"].replace("Value error, ", "")
		parts.append(f"{loc}: {msg}" if loc else msg)
	return "; ".join(parts)


def create_app(runtime):
	app = FastAPI(title="KINETRA Energia", version=runtime.version)
	auth = runtime.auth

	# ---- autenticazione ------------------------------------------------
	# Dipendenze asincrone: girano nel ciclo principale invece che in un pool di thread
	async def current_user(request: Request):
		header = request.headers.get("authorization", "")
		token = header[7:] if header.lower().startswith("bearer ") else None
		if not token:
			raise HTTPException(401, "Accesso richiesto")
		try:
			return auth.user_from_token(token)
		except AuthError as e:
			raise HTTPException(401, str(e))

	def require(level):
		async def dep(user=Depends(current_user)):
			if user["must_change_password"]:
				raise HTTPException(403, "Devi cambiare la password prima di continuare")
			if user["level"] < level:
				raise HTTPException(403, f"Serve il livello {LEVEL_NAMES[level]}")
			return user
		return dep

	viewer, operator, admin = require(LEVEL_READONLY), require(LEVEL_USER), require(LEVEL_ADMIN)

	# Interfaccia (stessa struttura di KINETRA Pesatura): guscio su "/", accesso su "/login"
	@app.get("/", include_in_schema=False)
	async def index():
		return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})

	@app.get("/login", include_in_schema=False)
	async def login_page():
		return FileResponse(STATIC / "login.html", headers={"Cache-Control": "no-cache"})

	@app.get("/api/version")
	async def version():
		return {"version": runtime.version}

	@app.post("/api/auth/login")
	async def login(req: LoginRequest):
		try:
			token, user = auth.login(req.username, req.password)
		except AuthError as e:
			raise HTTPException(401, str(e))
		return {"access_token": token, "token_type": "bearer", "token": token, "user": user}

	@app.get("/api/auth/me")
	async def me(user=Depends(current_user)):
		return public_user(user)

	@app.post("/api/auth/password")
	async def change_password(req: PasswordRequest, user=Depends(current_user)):
		try:
			auth.change_own_password(user, req.old_password, req.new_password)
		except AuthError as e:
			raise HTTPException(400, str(e))
		return {"ok": True}

	# ---- utenti --------------------------------------------------------
	@app.get("/api/users")
	async def users(user=Depends(admin)):
		return {"users": [public_user(u) for u in runtime.db.list_users()], "levels": LEVEL_NAMES}

	@app.post("/api/users")
	async def create_user(req: UserCreate, user=Depends(admin)):
		try:
			return auth.create_user(user, req.username, req.password, req.level, req.description)
		except AuthError as e:
			raise HTTPException(400, str(e))

	@app.put("/api/users/{user_id}")
	async def update_user(user_id: int, req: UserUpdate, user=Depends(admin)):
		try:
			return auth.update_user(user, user_id, req.description, req.level, req.password)
		except AuthError as e:
			raise HTTPException(400, str(e))

	@app.delete("/api/users/{user_id}")
	async def delete_user(user_id: int, user=Depends(admin)):
		try:
			auth.delete_user(user, user_id)
		except AuthError as e:
			raise HTTPException(400, str(e))
		return {"ok": True}

	# ---- impianto ------------------------------------------------------
	@app.get("/api/plant")
	async def plant(user=Depends(viewer)):
		return {**runtime.monitor.snapshot(), "simulator": runtime.simulator is not None, "sun": _sun()}

	def _sun():
		"""Posizione del sole per la vista 3D: all'ora simulata se il simulatore è attivo."""
		plant_cfg = runtime.config["plant"]
		tz = ZoneInfo(plant_cfg["timezone"])
		when = runtime.simulator.sim_now() if runtime.simulator else datetime.now(tz)
		elevation, azimuth = solar.sun_position(plant_cfg["latitude"], plant_cfg["longitude"], when)
		return {"elevation": round(elevation, 2), "azimuth": round(azimuth, 2),
				"time": when.astimezone(tz).isoformat(timespec="seconds"), "simulated": runtime.simulator is not None}

	@app.get("/api/devices/{name}/history")
	async def history(name: str, hours: float = 24, user=Depends(viewer)):
		if name not in {d.name for d in runtime.monitor.devices}:
			raise HTTPException(404, "Dispositivo sconosciuto")
		return runtime.db.history(name, time.time() - hours * 3600)

	@app.get("/api/alarms")
	async def alarms(active: bool = False, limit: int = 100, user=Depends(viewer)):
		return runtime.db.active_alarms() if active else runtime.db.alarms(limit)

	@app.post("/api/alarms/{alarm_id}/ack")
	async def ack(alarm_id: int, user=Depends(operator)):
		if not runtime.db.acknowledge_alarm(alarm_id):
			raise HTTPException(404, "Allarme non trovato")
		return {"ok": True}

	# ---- configurazione ------------------------------------------------
	@app.get("/api/config")
	async def get_config(user=Depends(admin)):
		return runtime.config

	@app.put("/api/config")
	async def put_config(config: dict, user=Depends(admin)):
		try:
			return await runtime.apply_config(config)
		except ValidationError as e:
			raise HTTPException(422, _validation_message(e))

	@app.post("/api/devices/test")
	async def test_device(req: DeviceTest, user=Depends(admin)):
		"""Prova la connessione Modbus/SunSpec a un dispositivo prima di salvarlo."""
		reader = SunSpecReader(timeout=runtime.config["polling"]["timeout_s"])
		dev = Device(name="test", type=req.type, host=req.host, port=req.port, unit_id=req.unit_id)
		try:
			values = await reader.read(dev)
			return {"ok": True, "info": dev.info, "models": sorted(dev.models), "values": values}
		except (ReadError, OSError) as e:
			return {"ok": False, "error": str(e)}
		finally:
			reader.close()

	# ---- report --------------------------------------------------------
	def _month(year, month):
		now = datetime.now()
		year, month = year or now.year, month or now.month
		if not 1 <= month <= 12 or not 2000 <= year <= 2100:
			raise HTTPException(400, "Mese non valido")
		return year, month

	@app.get("/api/report/monthly")
	async def report_json(year: int | None = None, month: int | None = None, user=Depends(viewer)):
		year, month = _month(year, month)
		data = month_data(runtime.db, runtime.config, year, month)
		data.pop("tz")
		return data

	@app.get("/api/report/monthly.pdf")
	async def report_pdf(year: int | None = None, month: int | None = None, user=Depends(viewer)):
		year, month = _month(year, month)
		pdf = build_pdf(month_data(runtime.db, runtime.config, year, month))
		filename = f"report-{year}-{month:02d}.pdf"
		return Response(pdf, media_type="application/pdf",
						headers={"Content-Disposition": f'inline; filename="{filename}"'})

	# ---- simulatore ----------------------------------------------------
	@app.get("/api/simulator")
	async def sim_state(user=Depends(viewer)):
		if runtime.simulator is None:
			raise HTTPException(404, "Simulatore non attivo")
		return {"state": runtime.simulator.state, "devices": runtime.simulator.describe()}

	@app.post("/api/simulator/{name}")
	async def sim_fault(name: str, req: FaultRequest, user=Depends(admin)):
		if runtime.simulator is None:
			raise HTTPException(404, "Simulatore non attivo")
		try:
			return runtime.simulator.set_fault(name, **req.model_dump())
		except KeyError:
			raise HTTPException(404, "Dispositivo sconosciuto")

	for folder in ("css", "js", "img"):
		app.mount(f"/{folder}", StaticFiles(directory=STATIC / folder), name=folder)
	return app
