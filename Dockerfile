# syntax=docker/dockerfile:1
FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TZ=Europe/Rome \
    IOT_SOLAR_CONFIG=/etc/iot-solar/config.json

WORKDIR /opt/iot-solar
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN mkdir -p /etc/iot-solar /opt/iot-solar/data

EXPOSE 8080
VOLUME ["/opt/iot-solar/data", "/etc/iot-solar"]
CMD ["python", "main.py"]
