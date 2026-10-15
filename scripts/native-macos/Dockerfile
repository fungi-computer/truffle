FROM ghcr.io/rust-cross/cargo-zigbuild@sha256:9b4f6b3eb9e8f9fefb3960fe288ddba576627d66d9eff851ce7f62d2455564a5
RUN rustup toolchain install 1.98.1 --profile minimal && rustup target add --toolchain 1.98.1 aarch64-apple-darwin x86_64-apple-darwin
ENV RUSTUP_TOOLCHAIN=1.98.1
ENV MACOSX_DEPLOYMENT_TARGET=13.5
