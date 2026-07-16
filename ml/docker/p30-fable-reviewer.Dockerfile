FROM node@sha256:f31365dd54da647fa44463f9b70391c748ffcf5e0ec0960115ab4b032d1f89ec

RUN npm install --global @anthropic-ai/claude-code@2.1.211 \
    && test "$(claude --version)" = "2.1.211 (Claude Code)" \
    && npm cache clean --force

RUN useradd --create-home --uid 10001 reviewer

USER 10001:10001
WORKDIR /review
ENTRYPOINT ["/usr/local/bin/claude"]
