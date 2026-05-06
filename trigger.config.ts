import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_YOUR_PROJECT_REF",
  dirs: ["src/trigger"],
  maxDuration: 300,
  // Disable auto-instrumentation to avoid multi-version OpenTelemetry conflicts
  instrumentations: [],
  build: {
    external: [
      "@opentelemetry/api",
      "@opentelemetry/api-logs",
      "@opentelemetry/core",
      "@opentelemetry/context-async-hooks",
      "@opentelemetry/exporter-logs-otlp-http",
      "@opentelemetry/exporter-metrics-otlp-http",
      "@opentelemetry/exporter-trace-otlp-grpc",
      "@opentelemetry/exporter-trace-otlp-http",
      "@opentelemetry/instrumentation",
      "@opentelemetry/resources",
      "@opentelemetry/sdk-logs",
      "@opentelemetry/sdk-metrics",
      "@opentelemetry/sdk-node",
      "@opentelemetry/sdk-trace-base",
      "@opentelemetry/sdk-trace-node",
      "@opentelemetry/semantic-conventions",
    ],
  },
});
