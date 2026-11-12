from modules.md_sunspec import sunspec


def test_inverter_roundtrip():
	regs = sunspec.encode_inverter(ac_power_w=12345, energy_wh=7_654_321, dc_voltage_v=612.3, dc_current_a=20.5,
								   dc_power_w=12700, ac_voltage_v=231.4, frequency_hz=50.01, temperature_c=41.2,
								   status=sunspec.STATE_MPPT)
	assert regs[:2] == [103, sunspec.INVERTER_LENGTH]
	v = sunspec.decode_inverter(regs[2:])
	assert v["ac_power_w"] == 12345
	assert v["energy_wh"] == 7_654_321
	assert abs(v["dc_voltage_v"] - 612.3) < 0.05
	assert abs(v["dc_current_a"] - 20.5) < 0.005
	assert abs(v["frequency_hz"] - 50.01) < 0.005
	assert abs(v["temperature_c"] - 41.2) < 0.05
	assert v["status_text"] == "MPPT"


def test_negative_and_not_implemented():
	assert sunspec.scaled(0xFFFE, 0) == -2
	assert sunspec.scaled(sunspec.NI_INT16, 0) is None
	assert sunspec.scaled(sunspec.NI_UINT16, 0, signed=False) is None
	assert sunspec.scaled(1234, 0xFFFF) == 123.4  # sf = -1


def test_common_and_image():
	common = sunspec.encode_common("ACME Solar", "X-50", "1.2.3", "SN123456")
	assert sunspec.decode_common(common[2:]) == {"manufacturer": "ACME Solar", "model": "X-50", "version": "1.2.3", "serial": "SN123456"}
	image = sunspec.build_image(common, sunspec.encode_irradiance(800, 900))
	assert image[:2] == sunspec.SUNS_MARKER
	assert image[-2:] == [sunspec.END_MODEL_ID, 0]
	irr = sunspec.decode_irradiance(image[2 + len(common) + 2:][:5])
	assert irr["ghi_wm2"] == 800 and irr["poa_wm2"] == 900 and irr["dni_wm2"] is None
