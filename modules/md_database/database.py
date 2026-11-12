"""Storico misure e allarmi su SQLite."""
import sqlite3
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS readings (
	ts REAL NOT NULL,
	device TEXT NOT NULL,
	ac_power_w REAL, dc_power_w REAL, dc_voltage_v REAL, dc_current_a REAL,
	energy_wh REAL, temperature_c REAL, status TEXT,
	poa_wm2 REAL, expected_w REAL
);
CREATE INDEX IF NOT EXISTS ix_readings_dev_ts ON readings(device, ts);
CREATE TABLE IF NOT EXISTS alarms (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	device TEXT NOT NULL,
	code TEXT NOT NULL,
	severity TEXT NOT NULL,
	message TEXT NOT NULL,
	hint TEXT,
	started_at REAL NOT NULL,
	ended_at REAL,
	acknowledged INTEGER NOT NULL DEFAULT 0,
	lost_wh REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_alarms_active ON alarms(ended_at);
"""

READING_FIELDS = ("ac_power_w", "dc_power_w", "dc_voltage_v", "dc_current_a", "energy_wh",
				  "temperature_c", "status", "poa_wm2", "expected_w")


class Database:
	def __init__(self, path):
		if path != ":memory:":
			Path(path).parent.mkdir(parents=True, exist_ok=True)
		self.conn = sqlite3.connect(path, check_same_thread=False)
		self.conn.row_factory = sqlite3.Row
		self.conn.executescript(SCHEMA)

	def close(self):
		self.conn.close()

	# ---- misure -------------------------------------------------------
	def insert_reading(self, device, values, ts=None):
		ts = ts or time.time()
		self.conn.execute(
			f"INSERT INTO readings (ts, device, {', '.join(READING_FIELDS)}) VALUES (?, ?, {', '.join('?' * len(READING_FIELDS))})",
			(ts, device, *[values.get(k) for k in READING_FIELDS]))
		self.conn.commit()

	def history(self, device, since_ts, max_points=500):
		rows = self.conn.execute("SELECT * FROM readings WHERE device = ? AND ts >= ? ORDER BY ts", (device, since_ts)).fetchall()
		step = max(1, len(rows) // max_points)
		return [dict(r) for r in rows[::step]]

	def energy_since(self, device, since_ts):
		"""Energia prodotta dal contatore dell'inverter (Wh) da `since_ts`."""
		row = self.conn.execute(
			"SELECT MIN(energy_wh) AS a, MAX(energy_wh) AS b FROM readings WHERE device = ? AND ts >= ? AND energy_wh IS NOT NULL",
			(device, since_ts)).fetchone()
		return (row["b"] - row["a"]) if row and row["a"] is not None else 0.0

	def lost_energy_since(self, device, since_ts):
		"""Integrale di max(atteso - reale, 0) nel tempo, in Wh."""
		rows = self.conn.execute(
			"SELECT ts, ac_power_w, expected_w FROM readings WHERE device = ? AND ts >= ? ORDER BY ts",
			(device, since_ts)).fetchall()
		lost = 0.0
		for prev, cur in zip(rows, rows[1:]):
			dt = cur["ts"] - prev["ts"]
			if dt <= 0 or dt > 900 or prev["expected_w"] is None:
				continue
			lost += max(prev["expected_w"] - (prev["ac_power_w"] or 0), 0) * dt / 3600
		return lost

	def purge_before(self, ts):
		self.conn.execute("DELETE FROM readings WHERE ts < ?", (ts,))
		self.conn.commit()

	# ---- allarmi ------------------------------------------------------
	def open_alarm(self, device, code, severity, message, hint=None, ts=None):
		cur = self.conn.execute(
			"INSERT INTO alarms (device, code, severity, message, hint, started_at) VALUES (?, ?, ?, ?, ?, ?)",
			(device, code, severity, message, hint, ts or time.time()))
		self.conn.commit()
		return cur.lastrowid

	def update_alarm(self, alarm_id, message=None, lost_wh=None):
		if message is not None:
			self.conn.execute("UPDATE alarms SET message = ? WHERE id = ?", (message, alarm_id))
		if lost_wh is not None:
			self.conn.execute("UPDATE alarms SET lost_wh = ? WHERE id = ?", (lost_wh, alarm_id))
		self.conn.commit()

	def close_alarm(self, alarm_id, ts=None):
		self.conn.execute("UPDATE alarms SET ended_at = ? WHERE id = ?", (ts or time.time(), alarm_id))
		self.conn.commit()

	def acknowledge_alarm(self, alarm_id):
		cur = self.conn.execute("UPDATE alarms SET acknowledged = 1 WHERE id = ?", (alarm_id,))
		self.conn.commit()
		return cur.rowcount > 0

	def active_alarms(self):
		return [dict(r) for r in self.conn.execute("SELECT * FROM alarms WHERE ended_at IS NULL ORDER BY started_at DESC")]

	def alarms(self, limit=100):
		return [dict(r) for r in self.conn.execute("SELECT * FROM alarms ORDER BY started_at DESC LIMIT ?", (limit,))]
