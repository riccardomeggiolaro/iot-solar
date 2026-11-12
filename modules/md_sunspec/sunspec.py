"""
Mappa registri SunSpec (Modbus) usata sia dal lettore sia dal simulatore.

Un dispositivo SunSpec espone, a partire da un indirizzo base (di solito 40000),
il marcatore "SunS" seguito da una catena di modelli: [ID, L, ...L registri...]
e termina con il modello 0xFFFF di lunghezza 0.

Modelli supportati:
  1   Common (marca, modello, numero di serie, versione)
  101/102/103  Inverter mono/split/trifase (interi + fattori di scala)
  302 Irradianza (GHI, POA, DFI, DNI, OTI in W/m2)
"""

BASE_ADDRESSES = (40000, 50000, 0)
SUNS_MARKER = [0x5375, 0x6E53]  # "SunS"
END_MODEL_ID = 0xFFFF

MODEL_COMMON = 1
INVERTER_MODELS = (101, 102, 103)
MODEL_IRRADIANCE = 302

COMMON_LENGTH = 66
INVERTER_LENGTH = 50
IRRADIANCE_LENGTH = 5

# Stati operativi dell'inverter (punto St)
INVERTER_STATES = {
	1: "OFF",
	2: "SLEEPING",
	3: "STARTING",
	4: "MPPT",
	5: "THROTTLED",
	6: "SHUTTING_DOWN",
	7: "FAULT",
	8: "STANDBY",
}
STATE_OFF, STATE_SLEEPING, STATE_MPPT, STATE_FAULT = 1, 2, 4, 7

# Offset dei punti all'interno del modello inverter (dopo ID e L)
INV = {
	"A": 0, "AphA": 1, "AphB": 2, "AphC": 3, "A_SF": 4,
	"PPVphAB": 5, "PPVphBC": 6, "PPVphCA": 7,
	"PhVphA": 8, "PhVphB": 9, "PhVphC": 10, "V_SF": 11,
	"W": 12, "W_SF": 13, "Hz": 14, "Hz_SF": 15,
	"VA": 16, "VA_SF": 17, "VAr": 18, "VAr_SF": 19, "PF": 20, "PF_SF": 21,
	"WH": 22, "WH_SF": 24,
	"DCA": 25, "DCA_SF": 26, "DCV": 27, "DCV_SF": 28, "DCW": 29, "DCW_SF": 30,
	"TmpCab": 31, "TmpSnk": 32, "TmpTrns": 33, "TmpOt": 34, "Tmp_SF": 35,
	"St": 36, "StVnd": 37, "Evt1": 38, "Evt2": 40,
}

NI_INT16 = 0x8000
NI_UINT16 = 0xFFFF


# ==== DECODIFICA =============================================

def to_int16(raw):
	return raw - 0x10000 if raw >= 0x8000 else raw


def scaled(raw, sf_raw, signed=True):
	"""Applica il fattore di scala SunSpec. Restituisce None se il punto non è implementato."""
	if raw is None or (signed and raw == NI_INT16) or (not signed and raw == NI_UINT16):
		return None
	if sf_raw == NI_INT16:
		return None
	value = to_int16(raw) if signed else raw
	return value * (10 ** to_int16(sf_raw))


def decode_string(regs):
	data = b"".join(r.to_bytes(2, "big") for r in regs)
	return data.split(b"\x00", 1)[0].decode("ascii", errors="ignore").strip()


def decode_common(block):
	"""block = registri del modello 1 senza ID e L."""
	return {
		"manufacturer": decode_string(block[0:16]),
		"model": decode_string(block[16:32]),
		"version": decode_string(block[40:48]),
		"serial": decode_string(block[48:64]),
	}


def decode_inverter(block):
	"""block = registri del modello 101/102/103 senza ID e L."""
	g = lambda k: block[INV[k]]
	wh_raw = (block[INV["WH"]] << 16) | block[INV["WH"] + 1]
	wh_sf = to_int16(g("WH_SF"))
	status = g("St")
	return {
		"ac_power_w": scaled(g("W"), g("W_SF")),
		"ac_current_a": scaled(g("A"), g("A_SF"), signed=False),
		"ac_voltage_v": scaled(g("PhVphA"), g("V_SF"), signed=False),
		"frequency_hz": scaled(g("Hz"), g("Hz_SF"), signed=False),
		"energy_wh": wh_raw * (10 ** wh_sf) if g("WH_SF") != NI_INT16 else None,
		"dc_current_a": scaled(g("DCA"), g("DCA_SF"), signed=False),
		"dc_voltage_v": scaled(g("DCV"), g("DCV_SF"), signed=False),
		"dc_power_w": scaled(g("DCW"), g("DCW_SF")),
		"temperature_c": scaled(g("TmpCab"), g("Tmp_SF")),
		"status": status,
		"status_text": INVERTER_STATES.get(status, "UNKNOWN"),
		"events": (block[INV["Evt1"]] << 16) | block[INV["Evt1"] + 1],
	}


def decode_irradiance(block):
	"""block = registri del modello 302 senza ID e L (primo blocco ripetuto)."""
	def val(i):
		return None if i >= len(block) or block[i] == NI_UINT16 else block[i]
	return {"ghi_wm2": val(0), "poa_wm2": val(1), "dfi_wm2": val(2), "dni_wm2": val(3), "oti_wm2": val(4)}


# ==== CODIFICA (usata dal simulatore) ========================

def encode_string(text, length):
	data = text.encode("ascii")[: length * 2].ljust(length * 2, b"\x00")
	return [int.from_bytes(data[i:i + 2], "big") for i in range(0, len(data), 2)]


def encode_common(manufacturer, model, version, serial, device_address=1):
	regs = encode_string(manufacturer, 16) + encode_string(model, 16) + encode_string("", 8)
	regs += encode_string(version, 8) + encode_string(serial, 16) + [device_address, 0]
	return [MODEL_COMMON, COMMON_LENGTH] + regs


def _int16(v):
	return int(round(v)) & 0xFFFF


def encode_inverter(ac_power_w, energy_wh, dc_voltage_v, dc_current_a, dc_power_w,
					ac_voltage_v=230.0, frequency_hz=50.0, temperature_c=25.0,
					status=STATE_MPPT, events=0, model_id=103):
	"""Codifica i valori con fattori di scala fissi (W x1, V x0.1, A x0.01, Hz x0.01, T x0.1)."""
	regs = [0] * INVERTER_LENGTH
	ac_current = ac_power_w / (3 * ac_voltage_v) if ac_voltage_v else 0
	regs[INV["A"]] = _int16(ac_current * 300)
	for k in ("AphA", "AphB", "AphC"):
		regs[INV[k]] = _int16(ac_current * 100)
	regs[INV["A_SF"]] = _int16(-2)
	for k in ("PPVphAB", "PPVphBC", "PPVphCA"):
		regs[INV[k]] = _int16(ac_voltage_v * 1.732 * 10)
	for k in ("PhVphA", "PhVphB", "PhVphC"):
		regs[INV[k]] = _int16(ac_voltage_v * 10)
	regs[INV["V_SF"]] = _int16(-1)
	regs[INV["W"]] = _int16(ac_power_w)
	regs[INV["W_SF"]] = 0
	regs[INV["Hz"]] = _int16(frequency_hz * 100)
	regs[INV["Hz_SF"]] = _int16(-2)
	regs[INV["VA"]] = _int16(ac_power_w)
	regs[INV["VA_SF"]] = 0
	regs[INV["VAr_SF"]] = 0
	regs[INV["PF"]] = 100
	regs[INV["PF_SF"]] = _int16(-2)
	wh = int(energy_wh) & 0xFFFFFFFF
	regs[INV["WH"]], regs[INV["WH"] + 1] = wh >> 16, wh & 0xFFFF
	regs[INV["WH_SF"]] = 0
	regs[INV["DCA"]] = _int16(dc_current_a * 100)
	regs[INV["DCA_SF"]] = _int16(-2)
	regs[INV["DCV"]] = _int16(dc_voltage_v * 10)
	regs[INV["DCV_SF"]] = _int16(-1)
	regs[INV["DCW"]] = _int16(dc_power_w)
	regs[INV["DCW_SF"]] = 0
	regs[INV["TmpCab"]] = _int16(temperature_c * 10)
	for k in ("TmpSnk", "TmpTrns", "TmpOt"):
		regs[INV[k]] = NI_INT16
	regs[INV["Tmp_SF"]] = _int16(-1)
	regs[INV["St"]] = status
	regs[INV["Evt1"]], regs[INV["Evt1"] + 1] = (events >> 16) & 0xFFFF, events & 0xFFFF
	return [model_id, INVERTER_LENGTH] + regs


def encode_irradiance(ghi, poa, dfi=None, dni=None, oti=None):
	vals = [ghi, poa, dfi, dni, oti]
	return [MODEL_IRRADIANCE, IRRADIANCE_LENGTH] + [NI_UINT16 if v is None else max(0, int(round(v))) for v in vals]


def build_image(*models):
	"""Immagine completa dei registri a partire dall'indirizzo base: SunS + modelli + fine."""
	regs = list(SUNS_MARKER)
	for m in models:
		regs += m
	return regs + [END_MODEL_ID, 0]
