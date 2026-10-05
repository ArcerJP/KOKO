import { configuredImageService, createImageHttpServer } from "./server.js";

// Only this executable reads process.env; importing the library opens no listener.
try {
  const port = process.env.PORT ?? "8080";
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535)
    throw new Error("INVALID_PORT");
  const server = createImageHttpServer(configuredImageService(process.env));
  server.once("error", () => {
    console.error("IMAGE_SERVICE_START_FAILED");
    process.exitCode = 1;
  });
  server.listen(Number(port), "0.0.0.0");
  process.once("SIGTERM", () => {
    server.close();
    setTimeout(() => {
      server.closeAllConnections();
      process.exit(0);
    }, 8000).unref();
  });
} catch {
  console.error("IMAGE_SERVICE_CONFIG_INVALID");
  process.exitCode = 1;
}
