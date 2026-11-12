import asyncio
from datetime import datetime, timezone

from modules.md_alarms.alarms import AlarmManager
from modules.md_analysis import solar
from modules.md_analysis.analyzer import analyze
from modules.md_database.database import Database
from modules.md_inverter.reader import Device
from modules.md_sunspec import sunspec


def inv(name, kwp=50, failures=0):
	return Device(name=name, type="inverter", host="x", kwp=kwp, failures=failures)


def reading(ac_w, status=sunspec.STATE_MPPT, temp=40):
	return {"ac_power_w": ac_w, "status": status, "temperature_c": temp, "events": 0}


def by_code(conditions, device, code):
	return next(c for c in conditions if c.device == device and c.code == code)


def test_sun_position_noon_summer_padova():
	elev = solar.sun_elevation_deg(45.41, 11.88, datetime(2026, 6, 21, 11, 15, tzinfo=timezone.utc))
	assert 66 < elev < 69
	assert solar.sun_elevation_deg(45.41, 11.88, datetime(2026, 6, 21, 0, 0, tzinfo=timezone.utc)) < 0
	assert solar.clear_sky_ghi(-5) == 0


def test_peer_comparison_without_sensor():
	devs = [inv("A"), inv("B"), inv("C"), inv("D", kwp=25)]
	readings = {"A": reading(30000), "B": reading(29500), "C": reading(18000), "D": reading(15000)}
	expected, conds, summary = analyze(devs, readings)
	assert by_code(conds, "C", "UNDERPERF_PEER").active is True
	assert by_code(conds, "A", "UNDERPERF_PEER").active is False
	assert by_code(conds, "D", "UNDERPERF_PEER").active is False  # normalizzato sui kWp
	assert by_code(conds, "C", "UNDERPERF_EXPECTED").active is None  # nessun sensore
	assert expected["C"] == summary["peer_median_kw_per_kwp"] * 50 * 1000


def test_expected_vs_sensor_and_plant_wide():
	devs = [inv("A"), inv("B"), Device(name="IRR", type="irradiance", host="x")]
	poa = 800
	healthy = solar.expected_ac_power(50, poa, 0.85)
	readings = {"A": reading(healthy * 0.98), "B": reading(healthy * 0.6), "IRR": {"poa_wm2": poa}}
	_, conds, _ = analyze(devs, readings)
	assert by_code(conds, "A", "UNDERPERF_EXPECTED").active is False
	low = by_code(conds, "B", "UNDERPERF_EXPECTED")
	assert low.active is True and "stringa" in low.hint
	assert by_code(conds, "IMPIANTO", "PLANT_UNDERPERF").active is False
	readings["A"] = reading(healthy * 0.7)
	_, conds, _ = analyze(devs, readings)
	assert by_code(conds, "IMPIANTO", "PLANT_UNDERPERF").active is True


def test_night_is_not_evaluated():
	devs = [inv("A"), inv("B"), inv("C"), Device(name="IRR", type="irradiance", host="x")]
	readings = {n: reading(0, status=sunspec.STATE_SLEEPING) for n in "ABC"} | {"IRR": {"poa_wm2": 0}}
	_, conds, _ = analyze(devs, readings)
	for c in conds:
		if c.code.startswith("UNDERPERF") or c.code == "PLANT_UNDERPERF":
			assert c.active is None


def test_alarm_hysteresis_and_loss():
	db = Database(":memory:")
	mgr = AlarmManager(db, {"persist_cycles": 3})
	devs = [inv("A"), inv("B"), inv("C")]
	bad = {"A": reading(30000), "B": reading(30000), "C": reading(10000)}
	good = {n: reading(30000) for n in "ABC"}

	def run(readings, n):
		for _ in range(n):
			_, conds, _ = analyze(devs, readings)
			asyncio.run(mgr.process(conds, dt_s=60))

	run(bad, 2)
	assert db.active_alarms() == []
	run(bad, 2)
	[alarm] = db.active_alarms()
	assert alarm["device"] == "C" and alarm["code"] == "UNDERPERF_PEER"
	assert abs(alarm["lost_wh"] - 20000 / 60) < 1   # 20 kW di deficit per 1 minuto
	run(good, 2)
	assert len(db.active_alarms()) == 1
	run(good, 1)
	assert db.active_alarms() == []


def test_offline_and_fault_open_immediately():
	db = Database(":memory:")
	mgr = AlarmManager(db)
	devs = [inv("A", failures=3), inv("B")]
	_, conds, _ = analyze(devs, {"A": None, "B": reading(0, status=sunspec.STATE_FAULT)})
	asyncio.run(mgr.process(conds, dt_s=5))
	codes = {(a["device"], a["code"]) for a in db.active_alarms()}
	assert codes == {("A", "OFFLINE"), ("B", "FAULT")}


def test_fault_counts_lost_energy():
	devs = [inv("A"), inv("B"), Device(name="IRR", type="irradiance", host="x")]
	_, conds, _ = analyze(devs, {"A": reading(30000), "B": reading(0, status=sunspec.STATE_FAULT), "IRR": {"poa_wm2": 800}})
	fault = by_code(conds, "B", "FAULT")
	assert fault.active and fault.deficit_w == solar.expected_ac_power(50, 800, 0.85)
