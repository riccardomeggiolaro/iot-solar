"""Schema e validazione della configurazione (config.json), condiviso da avvio e interfaccia web."""
import json
import os
import shutil
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

BASE = Path(__file__).resolve().parent.parent.parent
EXAMPLE_CONFIG = BASE / "config.example.json"


class PlantSettings(BaseModel):
	name: str = Field("Impianto", min_length=1, max_length=80)
	latitude: float = Field(45.4, ge=-90, le=90)
	longitude: float = Field(11.9, ge=-180, le=180)
	timezone: str = "Europe/Rome"
	energy_price_eur_kwh: float = Field(0.2, ge=0, le=5)
	owner: str = ""        # ragione sociale del cliente, per il report
	address: str = ""

	@field_validator("timezone")
	@classmethod
	def _tz(cls, v):
		from zoneinfo import ZoneInfo
		ZoneInfo(v)
		return v


class PollingSettings(BaseModel):
	interval_s: float = Field(5, ge=1, le=300)
	timeout_s: float = Field(3, ge=0.2, le=30)


class DeviceSettings(BaseModel):
	name: str = Field(min_length=1, max_length=40)
	type: Literal["inverter", "irradiance"]
	host: str = Field(min_length=1)
	port: int = Field(502, ge=1, le=65535)
	unit_id: int = Field(1, ge=0, le=255)
	kwp: float = Field(0, ge=0, le=100000)

	@model_validator(mode="after")
	def _kwp(self):
		if self.type == "inverter" and self.kwp <= 0:
			raise ValueError(f"{self.name}: indicare i kWp dell'inverter")
		return self


class AnalysisSettings(BaseModel):
	derate: float = Field(0.85, gt=0.3, le=1.1)
	min_irradiance: float = Field(150, ge=0)
	min_specific_power: float = Field(0.08, ge=0)
	peer_threshold: float = Field(0.15, gt=0, lt=1)
	expected_threshold: float = Field(0.20, gt=0, lt=1)
	overtemp_c: float = Field(75, ge=30, le=120)
	offline_after_failures: int = Field(3, ge=1, le=100)
	persist_cycles: int = Field(6, ge=1, le=1000)


class AlarmSettings(BaseModel):
	webhook_url: str = ""


class DatabaseSettings(BaseModel):
	retention_days: int = Field(400, ge=7, le=3650)


class ApiSettings(BaseModel):
	host: str = "0.0.0.0"
	port: int = Field(8080, ge=1, le=65535)
	token_hours: int = Field(24 * 30, ge=1, le=24 * 365)


class SimulatorSettings(BaseModel):
	enabled: bool = False
	host: str = "127.0.0.1"
	port: int = Field(5020, ge=1, le=65535)
	speed: float = Field(1, ge=0.1, le=10000)
	start_hour: float | None = Field(None, ge=0, lt=24)
	clouds: bool = True
	ambient_c: float = 22


class Settings(BaseModel):
	log_level: str = "INFO"
	plant: PlantSettings = PlantSettings()
	polling: PollingSettings = PollingSettings()
	devices: list[DeviceSettings] = []
	analysis: AnalysisSettings = AnalysisSettings()
	alarms: AlarmSettings = AlarmSettings()
	database: DatabaseSettings = DatabaseSettings()
	api: ApiSettings = ApiSettings()
	simulator: SimulatorSettings = SimulatorSettings()

	@model_validator(mode="after")
	def _unique(self):
		names = [d.name for d in self.devices]
		dup = {n for n in names if names.count(n) > 1}
		if dup:
			raise ValueError(f"Nomi dispositivo duplicati: {', '.join(sorted(dup))}")
		addrs = [(d.host, d.port, d.unit_id) for d in self.devices]
		if len(set(addrs)) != len(addrs):
			raise ValueError("Due dispositivi hanno lo stesso indirizzo (host, porta, unit id)")
		return self


def validate(config: dict) -> dict:
	"""Valida e completa con i default. Solleva pydantic.ValidationError."""
	return Settings.model_validate(config).model_dump()


def resolve_paths():
	"""Cartelle di configurazione e dati: variabili d'ambiente (Docker) o cartella del progetto."""
	config_dir = Path(os.environ.get("IOT_SOLAR_CONFIG_DIR") or BASE)
	data_dir = Path(os.environ.get("IOT_SOLAR_DATA_DIR") or BASE / "data")
	return config_dir / "config.json", data_dir


def load_config(path):
	"""Carica config.json; al primo avvio lo crea dall'esempio (impianto simulato)."""
	path = Path(path)
	if not path.exists():
		path.parent.mkdir(parents=True, exist_ok=True)
		shutil.copy(EXAMPLE_CONFIG, path)
	with open(path, encoding="utf-8") as f:
		return validate(json.load(f))


def save_config(path, config):
	path = Path(path)
	tmp = path.with_suffix(".json.tmp")
	with open(tmp, "w", encoding="utf-8") as f:
		json.dump(config, f, indent=4, ensure_ascii=False)
	os.replace(tmp, path)
