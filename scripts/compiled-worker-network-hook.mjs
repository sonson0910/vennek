import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const http = require("node:http");
const https = require("node:https");
const telegramPort = Number(process.env.VENNEK_SMOKE_TELEGRAM_PORT);
const extractorPort = Number(process.env.VENNEK_SMOKE_EXTRACTOR_PORT);

function hostOf(options) {
  if (typeof options === "string") return new URL(options).hostname;
  if (options instanceof URL) return options.hostname;
  return options?.hostname ?? options?.host;
}

function rewrite(options, hostname, port) {
  if (typeof options === "string" || options instanceof URL) {
    const url = new URL(options.toString());
    url.protocol = "http:";
    url.hostname = "127.0.0.1";
    url.port = String(port);
    return url;
  }
  return { ...options, protocol: "http:", hostname: "127.0.0.1", host: undefined, port };
}

const originalHttpRequest = http.request;
http.request = function patchedHttpRequest(options, ...args) {
  return hostOf(options) === "private-document-extractor"
    ? originalHttpRequest.call(http, rewrite(options, "private-document-extractor", extractorPort), ...args)
    : originalHttpRequest.call(http, options, ...args);
};

const originalHttpsRequest = https.request;
https.request = function patchedHttpsRequest(options, ...args) {
  return hostOf(options) === "api.telegram.org"
    ? originalHttpRequest.call(http, rewrite(options, "api.telegram.org", telegramPort), ...args)
    : originalHttpsRequest.call(https, options, ...args);
};

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const source = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
  const url = new URL(source);
  if (url.hostname !== "api.telegram.org") return originalFetch(input, init);
  return originalFetch(`http://127.0.0.1:${telegramPort}${url.pathname}${url.search}`, init);
};
