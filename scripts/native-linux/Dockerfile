# Ubuntu 22.04 amd64, jammy-20260924.1. Keep the libc floor at 2.35.
FROM ubuntu:22.04@sha256:08ea48a03a3e78ebc7cd526e6a275053223aadd88bfc09cc49b06d5281525fde
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl git pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup.sh \
    && sh /tmp/rustup.sh -y --profile minimal --default-toolchain 1.98.1 \
    && rm /tmp/rustup.sh \
    && chmod -R a+rX /opt/rustup /opt/cargo
ENV PATH=/opt/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV RUSTUP_TOOLCHAIN=1.98.1
