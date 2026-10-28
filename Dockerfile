FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
COPY public ./public
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /freetally . \
  && mkdir -p /out/data /out/tmp && chmod 1777 /out/tmp

# Just the binary: no shell, no package manager. It runs as root because Fly mounts volumes
# owned by root and there's no shell to change that; each Fly machine is its own small VM.
FROM scratch
COPY --from=build /freetally /freetally
COPY --from=build /out/data /data
COPY --from=build /out/tmp /tmp
ENV PORT=3000 DATA_DIR=/data GOMEMLIMIT=64MiB
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD ["/freetally", "-healthcheck"]
ENTRYPOINT ["/freetally"]
