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
CREATE TABLE IF NOT EXISTS users (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	username TEXT NOT NULL UNIQUE COLLATE NOCASE,
	password_hash TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	level INTEGER NOT NULL,
	must_change_password INTEGER NOT NULL DEFAULT 0,
	created_at REAL NOT NULL
);
"""

USER_FIELDS = ("username", "password_hash", "description", "level", "must_change_password")

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

	def energy_stats(self, since_ts, until_ts=None, devices=None):
		"""
		Per ogni dispositivo nell'intervallo, in Wh:
		- energy_wh: somma degli incrementi del contatore dell'inverter tra letture successive.
		  Si scartano gli incrementi negativi (contatore azzerato o inverter sostituito) e quelli
		  impossibili per la potenza misurata (salti del contatore), con una tolleranza di 1 kWh
		  per i contatori a bassa risoluzione;
		- expected_wh / lost_wh: integrale nel tempo di atteso e di max(atteso - reale, 0);
		- compared_wh: energia reale negli stessi intervalli in cui c'è un atteso (per il rendimento).
		Gli intervalli tra due letture più lunghi di 15 minuti (buchi di dati) non vengono integrati.
		"""
		until_ts = until_ts or time.time() + 1
		dev_filter, params = "", [since_ts, until_ts]
		if devices:
			dev_filter = f" AND device IN ({', '.join('?' * len(devices))})"
			params += list(devices)
		rows = self.conn.execute(f"""
			WITH r AS (
				SELECT device, ac_power_w, expected_w,
					LEAD(ts) OVER w - ts AS dt,
					LEAD(energy_wh) OVER w - energy_wh AS de,
					MAX(COALESCE(ac_power_w, 0), COALESCE(LEAD(ac_power_w) OVER w, 0)) AS pmax
				FROM readings WHERE ts >= ? AND ts < ?{dev_filter}
				WINDOW w AS (PARTITION BY device ORDER BY ts)
			)
			SELECT device,
				SUM(CASE WHEN de >= 0 AND de <= pmax * dt / 3600.0 * 1.5 + 1000 THEN de ELSE 0 END) AS energy_wh,
				SUM(CASE WHEN dt <= 900 THEN COALESCE(expected_w, 0) * dt ELSE 0 END) / 3600.0 AS expected_wh,
				SUM(CASE WHEN dt <= 900 AND expected_w > COALESCE(ac_power_w, 0)
					THEN (expected_w - COALESCE(ac_power_w, 0)) * dt ELSE 0 END) / 3600.0 AS lost_wh,
				SUM(CASE WHEN dt <= 900 AND expected_w IS NOT NULL
					THEN COALESCE(ac_power_w, 0) * dt ELSE 0 END) / 3600.0 AS compared_wh
			FROM r GROUP BY device""", params).fetchall()
		return {r["device"]: {"energy_wh": r["energy_wh"] or 0.0, "expected_wh": r["expected_wh"] or 0.0,
							  "lost_wh": r["lost_wh"] or 0.0, "compared_wh": r["compared_wh"] or 0.0} for r in rows}

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

	def alarms_between(self, since_ts, until_ts):
		"""Allarmi attivi almeno in parte nell'intervallo."""
		return [dict(r) for r in self.conn.execute(
			"SELECT * FROM alarms WHERE started_at < ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at",
			(until_ts, since_ts))]

	# ---- utenti -------------------------------------------------------
	def count_users(self):
		return self.conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]

	def create_user(self, username, password_hash, level, description="", must_change_password=False):
		cur = self.conn.execute(
			"INSERT INTO users (username, password_hash, description, level, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			(username, password_hash, description, level, int(must_change_password), time.time()))
		self.conn.commit()
		return cur.lastrowid

	def get_user(self, user_id=None, username=None):
		if user_id is not None:
			row = self.conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
		else:
			row = self.conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
		return dict(row) if row else None

	def list_users(self):
		return [dict(r) for r in self.conn.execute("SELECT * FROM users ORDER BY level DESC, username")]

	def update_user(self, user_id, **fields):
		fields = {k: v for k, v in fields.items() if k in USER_FIELDS and v is not None}
		if not fields:
			return
		sets = ", ".join(f"{k} = ?" for k in fields)
		self.conn.execute(f"UPDATE users SET {sets} WHERE id = ?", (*fields.values(), user_id))
		self.conn.commit()

	def delete_user(self, user_id):
		self.conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
		self.conn.commit()
