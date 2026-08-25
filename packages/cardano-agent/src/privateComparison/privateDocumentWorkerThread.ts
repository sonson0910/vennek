import { parentPort } from "node:worker_threads";
import {
  extractPrivateDocument,
  type PrivateDocumentMetadata,
} from "./privateDocumentWorker.js";

if (parentPort) {
  parentPort.on("message", (message: { bytes: ArrayBuffer; metadata: PrivateDocumentMetadata }) => {
    void extractPrivateDocument(new Uint8Array(message.bytes), message.metadata)
      .then((result) => parentPort!.postMessage({ ok: true, result }))
      .catch(() => parentPort!.postMessage({ ok: false, error: "Private document extraction failed" }));
  });
}
