"""API: login, livelli utente, configurazione da web, report."""
import json
import time

import pytest
from fastapi.testclient import TestClient

from applications.app_api import create_app
from modules.md_runtime.runtime import Runtime
from modules.md_runtime.settings import EXAMPLE_CONFIG


@pytest.fixture
def env(tmp_path):
	config = json.loads(EXAMPLE_CONFIG.read_text())
	config["simulator"]["enabled"] = False
	(tmp_path / "config.json").write_text(json.dumps(config))
	runtime = Runtime(tmp_path / "config.json", tmp_path / "data")
	runtime.auth.ensure_admin("primapassword")
	client = TestClient(create_app(runtime))
	yield runtime, client, tmp_path
	runtime.db.close()


def login(client, username, password):
	r = client.post("/api/auth/login", json={"username": username, "password": password})
	assert r.status_code == 200, r.text
	return {"Authorization": "Bearer " + r.json()["token"]}, r.json()["user"]


def admin_headers(client):
	h, user = login(client, "admin", "primapassword")
	assert user["must_change_password"]
	assert client.get("/api/plant", headers=h).status_code == 403  # prima deve cambiare password
	r = client.post("/api/auth/password", headers=h, json={"old_password": "primapassword", "new_password": "nuova-pass"})
	assert r.status_code == 200
	return h


def test_login_required_and_wrong_password(env):
	_, client, _ = env
	assert client.get("/api/plant").status_code == 401
	assert client.get("/api/version").status_code == 200
	assert client.post("/api/auth/login", json={"username": "admin", "password": "x"}).status_code == 401
	assert client.get("/api/plant", headers={"Authorization": "Bearer abc"}).status_code == 401


def test_levels(env):
	_, client, _ = env
	h = admin_headers(client)
	assert client.get("/api/plant", headers=h).status_code == 200

	r = client.post("/api/users", headers=h, json={"username": "mario", "password": "123456", "level": 1})
	assert r.status_code == 200 and r.json()["must_change_password"]
	hm, _ = login(client, "mario", "123456")
	client.post("/api/auth/password", headers=hm, json={"old_password": "123456", "new_password": "abcdef"})
	assert client.get("/api/plant", headers=hm).status_code == 200
	assert client.get("/api/config", headers=hm).status_code == 403
	assert client.post("/api/alarms/1/ack", headers=hm).status_code == 403
	assert client.get("/api/users", headers=hm).status_code == 403

	# un amministratore non può creare super admin né modificare altri amministratori
	client.post("/api/users", headers=h, json={"username": "capo", "password": "123456", "level": 3})
	hc, _ = login(client, "capo", "123456")
	client.post("/api/auth/password", headers=hc, json={"old_password": "123456", "new_password": "abcdef"})
	assert client.post("/api/users", headers=hc, json={"username": "x", "password": "123456", "level": 4}).status_code == 400
	assert client.post("/api/users", headers=hc, json={"username": "x", "password": "123456", "level": 3}).status_code == 400
	assert client.post("/api/users", headers=hc, json={"username": "x", "password": "123456", "level": 2}).status_code == 200
	admin_id = next(u["id"] for u in client.get("/api/users", headers=h).json()["users"] if u["username"] == "admin")
	assert client.delete(f"/api/users/{admin_id}", headers=hc).status_code == 400
	assert client.delete(f"/api/users/{admin_id}", headers=h).status_code == 400  # non elimina se stesso


def test_config_update_is_validated_saved_and_applied(env):
	runtime, client, tmp = env
	h = admin_headers(client)
	cfg = client.get("/api/config", headers=h).json()
	cfg["plant"]["name"] = "Capannone Nord"
	cfg["devices"] = cfg["devices"][:2]
	r = client.put("/api/config", headers=h, json=cfg)
	assert r.status_code == 200
	assert json.loads((tmp / "config.json").read_text())["plant"]["name"] == "Capannone Nord"
	assert [d.name for d in runtime.monitor.devices] == ["INV-1", "INV-2"]

	cfg["devices"].append(dict(cfg["devices"][0]))  # duplicato
	r = client.put("/api/config", headers=h, json=cfg)
	assert r.status_code == 422 and "duplicati" in r.json()["detail"]
	cfg["devices"].pop()
	cfg["devices"][0]["kwp"] = 0
	assert client.put("/api/config", headers=h, json=cfg).status_code == 422


def test_device_test_unreachable(env):
	_, client, _ = env
	h = admin_headers(client)
	r = client.post("/api/devices/test", headers=h, json={"host": "127.0.0.1", "port": 1, "unit_id": 1})
	assert r.status_code == 200 and r.json()["ok"] is False


def test_monthly_report(env):
	runtime, client, _ = env
	h = admin_headers(client)
	now = time.time()
	# un'ora di produzione: 20 kW reali contro 25 kW attesi, contatore che cresce
	for i in range(61):
		runtime.db.insert_reading("INV-1", {"ac_power_w": 20000, "expected_w": 25000, "energy_wh": 1_000_000 + i * 20000 / 60,
											"status": "MPPT"}, ts=now - 3600 + i * 60)
	runtime.db.open_alarm("INV-1", "UNDERPERF_EXPECTED", "warning", "INV-1 sotto l'atteso", "Pulire i moduli", now - 1800)
	r = client.get("/api/report/monthly", headers=h).json()
	inv1 = next(i for i in r["inverters"] if i["name"] == "INV-1")
	assert abs(inv1["energy_wh"] - 20000) < 1
	assert abs(inv1["expected_wh"] - 25000) < 1
	assert abs(inv1["lost_wh"] - 5000) < 1
	assert inv1["alarms"] == 1
	assert abs(inv1["performance"] - 0.8) < 0.01  # 20 kW su 25 kW attesi
	assert r["inverters"][1]["performance"] is None  # INV-2 senza dati
	pdf = client.get("/api/report/monthly.pdf", headers=h)
	assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF")
	assert len(pdf.content) > 3000


def test_energy_ignores_counter_resets_and_jumps(env):
	runtime, _, _ = env
	t0 = time.time() - 600
	counter = [1000, 1010, 5_000_000, 5_000_010, 20, 30]  # salto (riavvio) e azzeramento
	for i, e in enumerate(counter):
		runtime.db.insert_reading("INV-1", {"ac_power_w": 7200, "energy_wh": e}, ts=t0 + i * 5)
	stats = runtime.db.energy_stats(t0 - 1)
	assert stats["INV-1"]["energy_wh"] == 30  # solo i tre incrementi plausibili da 10 Wh


def test_reset_admin_command(tmp_path, monkeypatch):
	from modules.md_auth import reset_admin
	from modules.md_auth.auth import check_password
	from modules.md_database.database import Database
	monkeypatch.setenv("IOT_SOLAR_DATA_DIR", str(tmp_path))
	assert reset_admin.main(["x", "corta"]) == 1
	assert reset_admin.main(["x", "ripristino1"]) == 0
	db = Database(str(tmp_path / "iot-solar.db"))
	user = db.get_user(username="admin")
	assert check_password("ripristino1", user["password_hash"]) and user["must_change_password"] == 1
