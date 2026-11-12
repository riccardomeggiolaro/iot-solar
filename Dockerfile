# syntax=docker/dockerfile:1
# ==============================================================
# KINETRA Energia - immagine Docker (linux/amd64 e linux/arm64)
# ==============================================================
FROM python:3.12-slim-bookworm

ARG VERSION=dev
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TZ=Europe/Rome \
    IOT_SOLAR_VERSION=${VERSION} \
    IOT_SOLAR_CONFIG_DIR=/etc/iot-solar \
    IOT_SOLAR_DATA_DIR=/var/opt/iot-solar

WORKDIR /opt/iot-solar
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py config.example.json VERSION ./
COPY applications ./applications
COPY modules ./modules
RUN mkdir -p /etc/iot-solar /var/opt/iot-solar

EXPOSE 8080
VOLUME ["/etc/iot-solar", "/var/opt/iot-solar"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD python -c "import json,urllib.request;p=json.load(open('/etc/iot-solar/config.json'))['api']['port'];urllib.request.urlopen(f'http://127.0.0.1:{p}/api/version',timeout=4)" || exit 1
CMD ["python", "main.py"]
