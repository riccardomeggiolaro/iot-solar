"""
Report mensile di rendimento in PDF (reportlab, senza dipendenze di sistema).

Contenuto: riepilogo del mese, produzione giornaliera reale e attesa,
tabella per inverter, elenco degli allarmi con l'energia persa.
"""
import calendar
import io
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from reportlab.graphics.charts.barcharts import VerticalBarChart
from reportlab.graphics.charts.legends import Legend
from reportlab.graphics.shapes import Drawing
from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

MONTHS = ["", "Gennaio", "Febbraio", "Marzo", "Aprile", "Maggio", "Giugno", "Luglio",
		  "Agosto", "Settembre", "Ottobre", "Novembre", "Dicembre"]
ALARM_NAMES = {
	"OFFLINE": "Non comunica", "FAULT": "Inverter in guasto", "OVERTEMP": "Sovratemperatura",
	"UNDERPERF_EXPECTED": "Rendimento sotto l'atteso", "UNDERPERF_PEER": "Rendimento sotto gli altri inverter",
	"PLANT_UNDERPERF": "Calo di tutto l'impianto",
}
ACCENT = colors.HexColor("#1f5fd6")   # blu KINETRA (come l'interfaccia)
NAVY = colors.HexColor("#0f1e3d")
ORANGE = colors.HexColor("#f26a1b")
GREY = colors.HexColor("#8a96a3")
DARK = colors.HexColor("#17202e")
LINE = colors.HexColor("#d9dee3")
RED = colors.HexColor("#c0392b")


def _num(v, dec=1):
	s = f"{v:,.{dec}f}"
	return s.replace(",", "X").replace(".", ",").replace("X", ".")


def _eur(v):
	return _num(v, 2) + " €"


def _performance(stats, kwp):
	"""Energia reale / attesa negli stessi intervalli; None se l'atteso è troppo poco per essere
	significativo (meno di 0,5 kWh per kWp, cioè meno di circa mezz'ora di sole)."""
	if not kwp or stats["expected_wh"] < 500 * kwp:
		return None
	return stats["compared_wh"] / stats["expected_wh"]


def month_data(db, config, year, month):
	"""Dati aggregati del mese, usati sia dal PDF sia dall'API."""
	tz = ZoneInfo(config["plant"]["timezone"])
	price = config["plant"]["energy_price_eur_kwh"]
	inverters = [d for d in config["devices"] if d["type"] == "inverter"]
	names = [d["name"] for d in inverters]
	days_in_month = calendar.monthrange(year, month)[1]
	start = datetime(year, month, 1, tzinfo=tz)
	end = start + timedelta(days=days_in_month)
	now = datetime.now(tz)

	daily = []
	keys = ("energy_wh", "expected_wh", "lost_wh", "compared_wh")
	month_stats = {n: dict.fromkeys(keys, 0.0) for n in names}
	for day in range(days_in_month):
		d0 = datetime(year, month, day + 1, tzinfo=tz)
		st = {} if d0 > now else db.energy_stats(d0.timestamp(), (d0 + timedelta(days=1)).timestamp(), names)
		daily.append({"day": day + 1, **{k: sum(x[k] for x in st.values()) for k in keys}})
		for n, x in st.items():
			for k in x:
				month_stats[n][k] += x[k]

	alarms = db.alarms_between(start.timestamp(), end.timestamp())
	per_inverter = []
	for d in inverters:
		s = month_stats[d["name"]]
		per_inverter.append({
			"name": d["name"], "kwp": d["kwp"], **s,
			"specific_kwh_kwp": s["energy_wh"] / 1000 / d["kwp"] if d["kwp"] else 0,
			"performance": _performance(s, d["kwp"]),
			"alarms": sum(a["device"] == d["name"] for a in alarms),
		})
	tot = {k: sum(i[k] for i in per_inverter) for k in keys}
	kwp = sum(d["kwp"] for d in inverters)
	return {
		"plant": config["plant"], "year": year, "month": month, "kwp": kwp, "price": price,
		"energy_kwh": tot["energy_wh"] / 1000, "expected_kwh": tot["expected_wh"] / 1000, "lost_kwh": tot["lost_wh"] / 1000,
		"revenue_eur": tot["energy_wh"] / 1000 * price, "lost_eur": tot["lost_wh"] / 1000 * price,
		"specific_kwh_kwp": tot["energy_wh"] / 1000 / kwp if kwp else 0,
		"performance": _performance(tot, kwp),
		"daily": daily, "inverters": per_inverter, "alarms": alarms, "tz": tz,
	}


def _daily_chart(daily, width):
	height = 62 * mm
	drawing = Drawing(width, height)
	chart = VerticalBarChart()
	chart.x, chart.y = 12 * mm, 12 * mm
	chart.width, chart.height = width - 16 * mm, height - 22 * mm
	chart.data = [[d["energy_wh"] / 1000 for d in daily], [d["expected_wh"] / 1000 for d in daily]]
	chart.categoryAxis.categoryNames = [str(d["day"]) if d["day"] % 2 else "" for d in daily]
	chart.categoryAxis.labels.fontSize = 6.5
	chart.categoryAxis.labels.fontName = "Helvetica"
	chart.valueAxis.labels.fontName = "Helvetica"
	chart.categoryAxis.strokeColor = LINE
	chart.valueAxis.valueMin = 0
	chart.valueAxis.labels.fontSize = 7
	chart.valueAxis.strokeColor = LINE
	chart.valueAxis.gridStrokeColor = LINE
	chart.valueAxis.visibleGrid = True
	chart.groupSpacing = 2
	chart.barSpacing = 0.5
	chart.bars.strokeWidth = 0
	chart.bars.strokeColor = None
	chart.bars[0].fillColor = ACCENT
	chart.bars[1].fillColor = colors.HexColor("#c5ccd6")
	drawing.add(chart)
	legend = Legend()
	legend.x, legend.y = 14 * mm, height - 3 * mm
	legend.alignment = "right"
	legend.columnMaximum = 1
	legend.fontSize = 7.5
	legend.fontName = "Helvetica"
	legend.strokeColor = None
	legend.dx = legend.dy = 7
	legend.colorNamePairs = [(ACCENT, "Prodotta (kWh)"), (colors.HexColor("#c5ccd6"), "Attesa (kWh)")]
	drawing.add(legend)
	return drawing


def build_pdf(data):
	buf = io.BytesIO()
	plant = data["plant"]
	title = f"Report di rendimento – {MONTHS[data['month']]} {data['year']}"
	doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=16 * mm, rightMargin=16 * mm, topMargin=16 * mm,
							bottomMargin=18 * mm, title=title, author="KINETRA Energia")
	ss = getSampleStyleSheet()
	h1 = ParagraphStyle("h1", parent=ss["Title"], fontSize=17, leading=21, alignment=0, textColor=DARK, spaceAfter=2)
	h2 = ParagraphStyle("h2", parent=ss["Heading2"], fontSize=11.5, textColor=DARK, spaceBefore=10, spaceAfter=5)
	body = ParagraphStyle("b", parent=ss["Normal"], fontSize=9, leading=12, textColor=DARK)
	small = ParagraphStyle("s", parent=body, fontSize=7.5, leading=9.5, textColor=colors.HexColor("#66727f"))
	right = ParagraphStyle("r", parent=small, alignment=TA_RIGHT)
	width = A4[0] - 32 * mm - 12  # il frame ha 6 pt di margine interno per lato

	brand = ParagraphStyle("brand", parent=body, fontName="Helvetica-Bold", fontSize=10, leading=12, textColor=NAVY)
	story = [Paragraph('KINETRA <font color="#f26a1b">— ENERGIA</font>', brand), Spacer(1, 4), Paragraph(title, h1)]
	sub = plant["name"]
	if plant.get("owner"):
		sub = f"{plant['owner']} – {sub}"
	if plant.get("address"):
		sub += f" – {plant['address']}"
	story += [Paragraph(f"{sub} · {_num(data['kwp'], 1)} kWp installati", body), Spacer(1, 8)]

	perf = data["performance"]
	kpis = [
		("Energia prodotta", f"{_num(data['energy_kwh'], 0)} kWh"),
		("Energia attesa", f"{_num(data['expected_kwh'], 0)} kWh"),
		("Rendimento", f"{_num(perf * 100, 0)} %" if perf else "–"),
		("Produzione specifica", f"{_num(data['specific_kwh_kwp'], 1)} kWh/kWp"),
		("Valore energia", _eur(data["revenue_eur"])),
		("Perdite stimate", f"{_eur(data['lost_eur'])}"),
	]
	cell = lambda label, value, color=DARK: [Paragraph(label.upper(), small),
											 Paragraph(f'<font size="13" color="{color.hexval().replace("0x", "#")}"><b>{value}</b></font>', body)]
	kpi_rows = [[cell(*kpis[i]), cell(*kpis[i + 1]), cell(*kpis[i + 2], RED if i == 3 else DARK)] for i in (0, 3)]
	t = Table(kpi_rows, colWidths=[width / 3] * 3)
	t.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), 0.6, LINE), ("INNERGRID", (0, 0), (-1, -1), 0.6, LINE),
						   ("VALIGN", (0, 0), (-1, -1), "TOP"), ("TOPPADDING", (0, 0), (-1, -1), 6),
						   ("BOTTOMPADDING", (0, 0), (-1, -1), 7), ("LEFTPADDING", (0, 0), (-1, -1), 8)]))
	story += [t, Paragraph(f"Valori economici calcolati a {_num(data['price'], 3)} €/kWh. Il rendimento è il rapporto tra "
						   "energia prodotta e attesa, stimata dall'irraggiamento misurato o dal confronto tra inverter.", small)]

	story += [Paragraph("Produzione giornaliera", h2), _daily_chart(data["daily"], width)]

	head = ["Inverter", "kWp", "Prodotta kWh", "kWh/kWp", "Rendimento", "Persa kWh", "Persa €", "Allarmi"]
	rows = [head]
	for i in data["inverters"]:
		rows.append([i["name"], _num(i["kwp"], 1), _num(i["energy_wh"] / 1000, 0), _num(i["specific_kwh_kwp"], 1),
					 f"{_num(i['performance'] * 100, 0)} %" if i["performance"] else "–",
					 _num(i["lost_wh"] / 1000, 1), _eur(i["lost_wh"] / 1000 * data["price"]), str(i["alarms"])])
	t = Table(rows, colWidths=[width * w for w in (0.19, 0.08, 0.14, 0.11, 0.13, 0.12, 0.13, 0.10)], repeatRows=1)
	style = [("FONTSIZE", (0, 0), (-1, -1), 8.5), ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#66727f")),
			 ("LINEBELOW", (0, 0), (-1, -1), 0.5, LINE), ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
			 ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold")]
	for r, i in enumerate(data["inverters"], start=1):
		if i["performance"] and i["performance"] < 0.9:
			style.append(("TEXTCOLOR", (4, r), (4, r), RED))
	t.setStyle(TableStyle(style))
	story += [KeepTogether([Paragraph("Dettaglio inverter", h2), t])]

	story.append(Paragraph("Allarmi del mese", h2))
	if not data["alarms"]:
		story.append(Paragraph("Nessun allarme nel mese: l'impianto ha funzionato regolarmente.", body))
	else:
		rows = [["Dispositivo", "Problema", "Inizio", "Durata", "Persa"]]
		fmt = lambda ts: datetime.fromtimestamp(ts, data["tz"]).strftime("%d/%m %H:%M")
		for a in data["alarms"]:
			end = a["ended_at"]
			dur = (end - a["started_at"]) if end else None
			dur_s = "in corso" if dur is None else (f"{dur / 3600:.1f} h".replace(".", ",") if dur >= 3600 else f"{dur / 60:.0f} min")
			rows.append([a["device"], Paragraph(f"<b>{ALARM_NAMES.get(a['code'], a['code'])}</b><br/>{a['hint'] or ''}", small),
						 fmt(a["started_at"]), dur_s,
						 _eur(a["lost_wh"] / 1000 * data["price"]) if a["lost_wh"] else "–"])
		t = Table(rows, colWidths=[width * w for w in (0.15, 0.49, 0.14, 0.11, 0.11)], repeatRows=1)
		t.setStyle(TableStyle([("FONTSIZE", (0, 0), (-1, -1), 8.5), ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#66727f")),
							   ("LINEBELOW", (0, 0), (-1, -1), 0.5, LINE), ("VALIGN", (0, 0), (-1, -1), "TOP"),
							   ("ALIGN", (2, 0), (-1, -1), "RIGHT")]))
		story.append(t)

	generated = datetime.now(data["tz"]).strftime("%d/%m/%Y %H:%M")

	def footer(canvas, doc_):
		canvas.saveState()
		canvas.setFont("Helvetica", 7.5)
		canvas.setFillColor(colors.HexColor("#8a96a3"))
		canvas.drawString(16 * mm, 10 * mm, f"Generato da KINETRA Energia il {generated}")
		canvas.drawRightString(A4[0] - 16 * mm, 10 * mm, f"Pagina {doc_.page}")
		canvas.restoreState()

	doc.build(story, onFirstPage=footer, onLaterPages=footer)
	return buf.getvalue()


def monthly_report(db, config, year, month):
	return build_pdf(month_data(db, config, year, month))
