FROM ghcr.io/berriai/litellm-database:main-stable

COPY config.yaml /app/config.yaml

EXPOSE 4000

CMD ["--config", "/app/config.yaml", "--port", "4000"]
