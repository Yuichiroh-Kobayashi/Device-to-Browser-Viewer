FROM ubuntu@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates=20260601~24.04.1 \
        git=1:2.43.0-1ubuntu7.3 \
        nodejs=18.19.1+dfsg-6ubuntu5 \
        python3=3.12.3-0ubuntu2.1 \
        webpack=5.76.1+dfsg1+~cs17.16.16-1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
