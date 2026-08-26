import { parentPort } from "node:worker_threads";
import { classifyPrivateDocumentError } from "./privateDocumentProtocol.js";
import { extractPrivateDocument, type PrivateDocumentMetadata } from "./privateDocumentWorker.js";

if (parentPort) {
  parentPort.on("message", (message: { bytes: ArrayBuffer; metadata: PrivateDocumentMetadata }) => {
    void extractPrivateDocument(new Uint8Array(message.bytes), message.metadata)
      .then((result) => parentPort!.postMessage({ ok: true, result }))
      .catch((error: unknown) => {
        const category = classifyPrivateDocumentError(error);
        parentPort!.postMessage(category === undefined ? { ok: false } : { ok: false, category });
      });
  });
}
