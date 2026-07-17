FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py web_bundle.py ./
COPY static ./static
COPY scripts/build_web_bundle.py ./scripts/build_web_bundle.py

RUN python scripts/build_web_bundle.py /app/app-bundle

# Optional acquisition plugin (GaLib-Finder submodule). Present only when the
# submodule is checked out; its extra deps are installed when it ships a
# requirements.txt — mirroring the core/plugin dependency split.
COPY finder ./finder
RUN if [ -f finder/requirements.txt ]; then \
      pip install --no-cache-dir -r finder/requirements.txt; \
    fi

RUN mkdir -p /data/downloads /data/config

EXPOSE 8765

CMD ["python", "app.py"]
