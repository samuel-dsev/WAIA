import http from "node:http";
import https from "node:https";

const host = "127.0.0.1";
const port = 3999;
const allowedMethods = new Set(["GET", "POST"]);

const server = http.createServer((request, response) => {
  const url = new URL(request.url || "/", `http://${host}:${port}`);
  if (url.pathname !== "/webhook" || !allowedMethods.has(request.method || "")) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
    return;
  }

  const headers = { ...request.headers, host: "api.localhost" };
  delete headers.connection;
  const upstream = https.request({
    hostname: "api.localhost",
    port: 443,
    path: `${url.pathname}${url.search}`,
    method: request.method,
    headers,
    servername: "api.localhost",
    rejectUnauthorized: false,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });

  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end("bad gateway");
  });
  request.pipe(upstream);
});

server.listen(port, host, () => {
  process.stdout.write(`webhook proxy ready on http://${host}:${port}/webhook\n`);
});

