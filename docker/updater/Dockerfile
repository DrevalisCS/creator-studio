# Tiny sidecar that watches /shared/do_update and runs docker compose to
# pull + restart the stack when it appears. Has access to the host's
# Docker socket + the project's compose file so `docker compose` Just Works.
FROM docker:27-cli

RUN apk add --no-cache bash curl

COPY update.sh /usr/local/bin/update.sh
RUN chmod +x /usr/local/bin/update.sh

WORKDIR /project

# Sanity: fail fast if bash or docker are missing.
RUN bash --version && docker --version

CMD ["bash", "/usr/local/bin/update.sh"]
