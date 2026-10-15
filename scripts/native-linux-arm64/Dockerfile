# Build arm64 against Ubuntu 22.04's glibc 2.35 from the pinned amd64 host.
FROM ubuntu:22.04@sha256:08ea48a03a3e78ebc7cd526e6a275053223aadd88bfc09cc49b06d5281525fde
RUN dpkg --add-architecture arm64 \
    && sed -i 's/^deb /deb [arch=amd64] /' /etc/apt/sources.list \
    && printf '%s\n' \
      'deb [arch=arm64] http://ports.ubuntu.com/ubuntu-ports jammy main universe' \
      'deb [arch=arm64] http://ports.ubuntu.com/ubuntu-ports jammy-updates main universe' \
      'deb [arch=arm64] http://ports.ubuntu.com/ubuntu-ports jammy-security main universe' \
      > /etc/apt/sources.list.d/arm64.list \
    && apt-get update && apt-get install -y --no-install-recommends \
      build-essential gcc-aarch64-linux-gnu g++-aarch64-linux-gnu \
      ca-certificates curl git pkg-config libssl-dev:arm64 qemu-user \
    && rm -rf /var/lib/apt/lists/*
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup.sh \
    && sh /tmp/rustup.sh -y --profile minimal --default-toolchain 1.98.1 \
    && /opt/cargo/bin/rustup target add --toolchain 1.98.1 aarch64-unknown-linux-gnu \
    && rm /tmp/rustup.sh \
    && chmod -R a+rX /opt/rustup /opt/cargo
ENV PATH=/opt/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV RUSTUP_TOOLCHAIN=1.98.1
ENV CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc
ENV CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc
ENV CXX_aarch64_unknown_linux_gnu=aarch64-linux-gnu-g++
ENV AR_aarch64_unknown_linux_gnu=aarch64-linux-gnu-ar
ENV PKG_CONFIG_ALLOW_CROSS=1
ENV PKG_CONFIG_LIBDIR=/usr/lib/aarch64-linux-gnu/pkgconfig:/usr/share/pkgconfig
