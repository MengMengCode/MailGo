# ── Stage 1: Build frontend ──────────────────────────────────────
FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --prefer-offline
COPY frontend/ ./
RUN npm run build

# ── Stage 2: Build backend (with embedded frontend) ─────────────
FROM golang:1.24-alpine AS backend-build
RUN apk add --no-cache git
WORKDIR /app/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
# Copy frontend dist into the embed directory
COPY --from=frontend-build /app/frontend/dist ./frontend-dist/
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /mailgo .

# ── Stage 3: Minimal runtime ────────────────────────────────────
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app
COPY --from=backend-build /mailgo /app/mailgo

EXPOSE 8080
ENV SERVER_PORT=8080

ENTRYPOINT ["/app/mailgo"]
