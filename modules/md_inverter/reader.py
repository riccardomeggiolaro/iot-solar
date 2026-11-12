"""
Lettore Modbus TCP per dispositivi SunSpec (inverter e sensori di irraggiamento).

Alla prima connessione individua l'indirizzo base e la catena dei modelli,
poi a ogni polling legge solo i blocchi che servono.
"""
import asyncio
import logging
from dataclasses import dataclass, field

from pymodbus.client import AsyncModbusTcpClient

from modules.md_sunspec import sunspec

log = logging.getLogger("reader")
MAX_REGS_PER_READ = 120


class ReadError(Exception):
	pass


class NoResponse(ReadError):
	"""Il dispositivo non risponde (timeout / connessione): inutile insistere in questo ciclo."""


@dataclass
class Device:
	name: str
	type: str            # "inverter" | "irradiance"
	host: str
	port: int = 502
	unit_id: int = 1
	kwp: float = 0.0
	models: dict = field(default_factory=dict)   # id -> (indirizzo, lunghezza)
	info: dict = field(default_factory=dict)
	failures: int = 0


class SunSpecReader:
	def __init__(self, timeout=3.0):
		self.timeout = timeout
		self._clients = {}
		self._locks = {}   # una richiesta alla volta per connessione (gateway e RS485 sono half-duplex)

	async def _client(self, host, port):
		key = (host, port)
		client = self._clients.get(key)
		if client is None:
			client = AsyncModbusTcpClient(host, port=port, timeout=self.timeout, retries=0)
			self._clients[key] = client
		if not client.connected:
			await client.connect()
		if not client.connected:
			raise NoResponse(f"connessione fallita {host}:{port}")
		return client

	async def _read(self, dev, address, count):
		lock = self._locks.setdefault((dev.host, dev.port), asyncio.Lock())
		async with lock:
			return await self._read_locked(dev, address, count)

	async def _read_locked(self, dev, address, count):
		client = await self._client(dev.host, dev.port)
		out = []
		while count > 0:
			n = min(count, MAX_REGS_PER_READ)
			try:
				rr = await client.read_holding_registers(address, count=n, slave=dev.unit_id)
			except Exception as e:
				raise NoResponse(f"{dev.name}: {e}") from e
			if rr.isError():
				raise ReadError(f"{dev.name}: risposta di errore {rr}")
			out += rr.registers
			address += n
			count -= n
		return out

	async def discover(self, dev):
		"""Trova l'indirizzo base SunSpec e la mappa dei modelli."""
		for base in sunspec.BASE_ADDRESSES:
			try:
				marker = await self._read(dev, base, 2)
			except NoResponse:
				raise
			except ReadError:
				continue
			if marker == sunspec.SUNS_MARKER:
				break
		else:
			raise ReadError(f"{dev.name}: marcatore SunSpec non trovato")
		models, addr = {}, base + 2
		for _ in range(50):
			model_id, length = await self._read(dev, addr, 2)
			if model_id == sunspec.END_MODEL_ID:
				break
			models.setdefault(model_id, (addr, length))
			addr += 2 + length
		dev.models = models
		if sunspec.MODEL_COMMON in models:
			a, l = models[sunspec.MODEL_COMMON]
			dev.info = sunspec.decode_common(await self._read(dev, a + 2, l))
		log.info("%s: modelli SunSpec %s %s", dev.name, sorted(models), dev.info)

	async def read(self, dev):
		"""Legge i valori correnti. Restituisce un dict normalizzato."""
		if not dev.models:
			await self.discover(dev)
		if dev.type == "inverter":
			model = next((m for m in sunspec.INVERTER_MODELS if m in dev.models), None)
			if model is None:
				raise ReadError(f"{dev.name}: nessun modello inverter")
			a, l = dev.models[model]
			return sunspec.decode_inverter(await self._read(dev, a + 2, l))
		if dev.type == "irradiance":
			if sunspec.MODEL_IRRADIANCE not in dev.models:
				raise ReadError(f"{dev.name}: nessun modello irraggiamento")
			a, l = dev.models[sunspec.MODEL_IRRADIANCE]
			return sunspec.decode_irradiance(await self._read(dev, a + 2, l))
		raise ReadError(f"{dev.name}: tipo sconosciuto {dev.type}")

	def invalidate(self, dev):
		"""Dopo un errore forza una nuova scoperta; chiude la connessione solo se è caduta,
		perché può essere condivisa con altri dispositivi dietro lo stesso gateway."""
		dev.models = {}
		key = (dev.host, dev.port)
		client = self._clients.get(key)
		if client is not None and not client.connected:
			self._clients.pop(key).close()

	def close(self):
		for c in self._clients.values():
			c.close()
		self._clients.clear()
