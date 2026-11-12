"""
Modelli fisici semplici: posizione del sole, irraggiamento a cielo sereno,
potenza attesa di un impianto. Bastano per la simulazione e per la stima
della produzione attesa; non sostituiscono un modello di dettaglio (pvlib).
"""
from datetime import datetime, timezone
from math import acos, cos, degrees, exp, pi, radians, sin

DEFAULT_TEMP_COEFF = -0.0037  # %/°C tipico del silicio cristallino


def sun_position(latitude, longitude, when):
	"""
	Posizione del sole (formule NOAA): (elevazione, azimut) in gradi.
	Azimut misurato da nord in senso orario (90 = est, 180 = sud, 270 = ovest).
	`when` aware oppure UTC naive.
	"""
	if when.tzinfo is not None:
		when = when.astimezone(timezone.utc)
	doy = when.timetuple().tm_yday
	hour = when.hour + when.minute / 60 + when.second / 3600
	g = 2 * pi / 365 * (doy - 1 + (hour - 12) / 24)
	eqtime = 229.18 * (0.000075 + 0.001868 * cos(g) - 0.032077 * sin(g)
					   - 0.014615 * cos(2 * g) - 0.040849 * sin(2 * g))
	decl = (0.006918 - 0.399912 * cos(g) + 0.070257 * sin(g) - 0.006758 * cos(2 * g)
			+ 0.000907 * sin(2 * g) - 0.002697 * cos(3 * g) + 0.00148 * sin(3 * g))
	true_solar_min = hour * 60 + eqtime + 4 * longitude
	ha = radians(true_solar_min / 4 - 180)
	lat = radians(latitude)
	cos_zen = max(-1.0, min(1.0, sin(lat) * sin(decl) + cos(lat) * cos(decl) * cos(ha)))
	zen = acos(cos_zen)
	elevation = 90 - degrees(zen)
	denom = cos(lat) * sin(zen)
	if abs(denom) < 1e-9:
		azimuth = 180.0
	else:
		cos_az = max(-1.0, min(1.0, (sin(lat) * cos_zen - sin(decl)) / denom))
		az = degrees(acos(cos_az))
		azimuth = (az + 180) % 360 if ha > 0 else (540 - az) % 360
	return elevation, azimuth


def sun_elevation_deg(latitude, longitude, when):
	"""Elevazione del sole in gradi."""
	return sun_position(latitude, longitude, when)[0]


def clear_sky_ghi(elevation_deg):
	"""Irraggiamento orizzontale globale a cielo sereno (modello di Haurwitz), W/m2."""
	if elevation_deg <= 0:
		return 0.0
	cz = sin(radians(elevation_deg))
	return 1098 * cz * exp(-0.059 / cz)


def approx_poa(ghi, elevation_deg):
	"""Stima grossolana dell'irraggiamento sul piano dei moduli (inclinazione ~30°, sud)."""
	if ghi <= 0 or elevation_deg <= 0:
		return 0.0
	gain = 1 + 0.35 * cos(radians(elevation_deg))
	return ghi * min(gain, 1.35)


def cell_temperature(ambient_c, poa, noct=45.0):
	return ambient_c + poa * (noct - 20) / 800


def expected_ac_power(kwp, poa, derate, cell_temp_c=None, temp_coeff=DEFAULT_TEMP_COEFF):
	"""Potenza AC attesa in W dato l'irraggiamento sul piano (W/m2)."""
	if poa is None or poa <= 0:
		return 0.0
	p = kwp * poa * derate  # kwp * 1000 W * poa/1000
	if cell_temp_c is not None:
		p *= 1 + temp_coeff * (cell_temp_c - 25)
	return max(p, 0.0)


def now_utc():
	return datetime.now(timezone.utc)
