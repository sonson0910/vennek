import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = "docker-compose.yml";
const envFile = ".env.example";
const project = `vennek-private-${process.pid}`;
const composeEnvironment: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
  ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
};

type Service = {
  image?: string;
  command?: string[];
  environment?: Record<string, string | null>;
  ports?: unknown;
  expose?: string[];
  networks?: Record<string, unknown>;
  healthcheck?: { test?: string[] };
  restart?: string;
  mem_limit?: string;
  memswap_limit?: string;
  cpus?: number;
  pids_limit?: number;
  read_only?: boolean;
  tmpfs?: string[];
  cap_drop?: string[];
  security_opt?: string[];
  user?: string;
  init?: boolean;
};

type RenderedCompose = {
  services: Record<string, Service>;
  networks: Record<string, { internal?: boolean }>;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function runWithCleanup<T>(primary: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  let primaryError: unknown;
  let result!: T;
  try {
    result = await primary();
  } catch (error) {
    primaryError = error;
  }
  let cleanupError: unknown;
  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError !== undefined && cleanupError !== undefined) {
    throw new AggregateError([primaryError, cleanupError], "private extractor verification failed");
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
  return result;
}

async function docker(args: string[], label: string): Promise<string> {
  try {
    const result = await exec("docker", args, {
      cwd: root,
      env: composeEnvironment,
      maxBuffer: 16 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string"
      ? error.stderr.trim().slice(0, 2_000)
      : "";
    throw new Error(`docker ${label} failed${stderr ? `: ${stderr}` : ""}`);
  }
}

function compose(...args: string[]): string[] {
  return ["compose", "--project-name", project, "--env-file", envFile, "-f", composeFile, ...args];
}

async function renderedCompose(): Promise<RenderedCompose> {
  const output = await docker(compose("config", "--format", "json"), "compose config");
  return JSON.parse(output) as RenderedCompose;
}

function assertSandbox(service: Service, network: string, port: string): void {
  assert(service.ports === undefined, `${network} must not publish a host port`);
  assert(service.expose?.includes(port), `${network} must expose ${port}`);
  assert(service.networks && Object.keys(service.networks).length === 1 && service.networks[network] === null, `${network} network boundary changed`);
  assert(service.mem_limit === "268435456" && service.memswap_limit === "268435456", `${network} memory limit changed`);
  assert(service.cpus === 0.5 && service.pids_limit === 64, `${network} CPU/PID limit changed`);
  assert(service.read_only === true, `${network} root filesystem is writable`);
  assert(service.tmpfs?.[0]?.includes("/tmp:size=16m"), `${network} /tmp is not bounded`);
  assert(["noexec", "nosuid", "nodev"].every((value) => service.tmpfs?.[0]?.includes(value)), `${network} /tmp flags changed`);
  assert(service.cap_drop?.includes("ALL"), `${network} capabilities are not dropped`);
  assert(service.security_opt?.some((value) => value === "no-new-privileges:true"), `${network} no-new-privileges is missing`);
  assert(service.user === "1000:1000" && service.init === true, `${network} process hardening changed`);
  assert(service.restart === "unless-stopped", `${network} restart policy changed`);
}

function assertStaticContracts(): void {
  const configText = requireText("config/litellm.example.yaml");
  for (const [alias, model] of [
    ["cardano-private-quality", "PRIVATE_OPENAI_QUALITY_MODEL"],
    ["cardano-private-verifier", "PRIVATE_OPENAI_VERIFIER_MODEL"],
  ] as const) {
    assert((configText.match(new RegExp(`model_name: ${alias}`, "g")) ?? []).length === 1, `${alias} must be declared once`);
    const section = configText.slice(configText.indexOf(`model_name: ${alias}`), configText.indexOf("\n  - model_name:", configText.indexOf(`model_name: ${alias}`) + 1) === -1 ? undefined : configText.indexOf("\n  - model_name:", configText.indexOf(`model_name: ${alias}`) + 1));
    assert(section.includes(`model: os.environ/${model}`), `${alias} model parameter changed`);
    assert(section.includes("api_key: os.environ/PRIVATE_OPENAI_API_KEY"), `${alias} provider key changed`);
  }
}

function requireText(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

async function assertRenderedContracts(config: RenderedCompose): Promise<{ image: string; token: string }> {
  const privateExtractor = config.services["private-document-extractor"];
  const worker = config.services["agent-worker"];
  const knowledgeWorker = config.services["knowledge-worker"];
  const pdfExtractor = config.services["pdf-extractor"];
  const litellm = config.services.litellm;
  assert(privateExtractor && worker && knowledgeWorker && pdfExtractor && litellm, "private Compose services are incomplete");
  assert(privateExtractor.command?.join(" ") === "node packages/cardano-agent/dist/privateComparison/privateDocumentServer.js", "unexpected private extractor command");
  assert(privateExtractor.healthcheck?.test?.join(" ").includes("127.0.0.1:8083"), "private extractor healthcheck is missing");
  assert(privateExtractor.healthcheck?.test?.join(" ").includes("r.status === 200"), "private extractor healthcheck must require readiness");
  assertSandbox(privateExtractor, "private-document-sandbox", "8083");
  assert(config.networks["private-document-sandbox"]?.internal === true, "private-document-sandbox must be internal");
  assert(worker.networks?.default === null && worker.networks?.["private-document-sandbox"] === null && Object.keys(worker.networks).length === 2, "agent-worker private network boundary changed");
  assert(knowledgeWorker.networks?.["private-document-sandbox"] === undefined, "knowledge-worker crossed into private network");
  assert(JSON.stringify(pdfExtractor.networks) === JSON.stringify({ "pdf-sandbox": null }), "public PDF network boundary changed");
  assert(worker.environment?.PRIVATE_DOCUMENT_EXTRACTOR_URL === "http://private-document-extractor:8083", "private extractor URL changed");
  assert(worker.environment?.VENNEK_PRIVATE_MODEL_QUALITY?.startsWith("cardano-private-"), "private quality alias is not isolated");
  assert(worker.environment?.VENNEK_PRIVATE_MODEL_VERIFIER?.startsWith("cardano-private-"), "private verifier alias is not isolated");
  const token = privateExtractor.environment?.PRIVATE_DOCUMENT_EXTRACTOR_TOKEN;
  const pdfToken = pdfExtractor.environment?.PDF_EXTRACTOR_TOKEN;
  assert(typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token), "private extractor token is invalid");
  assert(token !== pdfToken, "private and public extractor tokens must differ");
  assert(litellm.environment?.PRIVATE_OPENAI_QUALITY_MODEL !== undefined && litellm.environment?.PRIVATE_OPENAI_VERIFIER_MODEL !== undefined, "private model parameters are not operator supplied");
  return { image: privateExtractor.image ?? "", token };
}

const generatedSafeDocxBase64 = "UEsDBBQAAAAIAAAAAAD3S4B1wgAAAHYBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2QuQ7CMAyGX6XKiqgRAwOiLMAKDLyAlbptRC7FLsfbk3INCBjt//gsLw7XSFxcnPVcqU4kzgFYd+SQyxDJZ6UJyaHkMbUQUR+xJZhOJjPQwQt5GcvQoZaLNTXYWyk2l7xmE3ylEllWxephHFiVwhit0ShZh5OvPyjjJ6HMybuHOxN5lA0KvhIG5TfgmdudKCVTU7HHJFt02QXnkGqog+5dTpb/a77cGZrGaHrnh7aYgiZm41tny7fi0PjX/XB/9/IGUEsDBBQAAAAIAAAAAAA3H46cgQAAAOgAAAALAAAAX3JlbHMvLnJlbHONzzEOwjAMBdCrRDlAXTEwoDQTJ0C9gJW6SUQTR4kRcHsyMBTEwOj/v55kc6ENJXJuIZamHmnLbdJBpJwAmguUsA1cKPdm5ZpQ+lk9FHRX9ASHcTxC3Rvamr2p5mehf0Re1+jozO6WKMsP+Guh1YzVk0z6znWB5R0PndVgDXw8Zl9QSwMEFAAAAAgAAAAAAHysnDuAAAAArAAAABEAAAB3b3JkL2RvY3VtZW50LnhtbEXOMQ7CMAwF0KtEPQCuGBiikIWThMa0EXUcOYaU29OUgeV9WV/6sms28vQizGo2WnO17TosqsUC1GlBCvXEBfPePVgo6H7KDI0lFuEJa015phXO43gBCikP3jV75/jpWTrSUX8LEkNmUyS9g6KpxE80ips66H1XDsvhbwP+//kvUEsBAhQAFAAAAAgAAAAAAPdLgHXCAAAAdgEAABMAAAAAAAAAAAAAAAAAAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAAUAAAACAAAAAAANx+OnIEAAADoAAAACwAAAAAAAAAAAAAAAADzAAAAX3JlbHMvLnJlbHNQSwECFAAUAAAACAAAAAAAfKycO4AAAACsAAAAEQAAAAAAAAAAAAAAAACdAQAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAMAAwC5AAAATAIAAAAA";

function makeSafePdf(active = false): Buffer {
  const content = "BT /F1 18 Tf 72 720 Td (Cardano private PDF smoke) Tj ET";
  const objects = [
    active ? "<< /Type /Catalog /Pages 2 0 R /OpenAction 6 0 R >>" : "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  if (active) objects.push("<< /S /JavaScript /JS (app.alert) >>");
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source);
}

async function smoke(image: string, token: string): Promise<void> {
  const fixtureDir = await mkdtemp(join(tmpdir(), "vennek-private-extractor-"));
  await runWithCleanup(async () => {
    const text = Buffer.from("Cardano private Compose smoke text\n");
    const docx = Buffer.from(generatedSafeDocxBase64, "base64");
    const unsafePdf = makeSafePdf(true);
    await Promise.all([
      writeFile(join(fixtureDir, "safe.txt"), text),
      writeFile(join(fixtureDir, "safe.docx"), docx),
      writeFile(join(fixtureDir, "safe.pdf"), makeSafePdf()),
      writeFile(join(fixtureDir, "unsafe.pdf"), unsafePdf),
      writeFile(join(fixtureDir, "spoofed.pdf"), makeSafePdf()),
    ]);
    const values = {
      text: (await readFile(join(fixtureDir, "safe.txt"))).toString("base64"),
      docx: (await readFile(join(fixtureDir, "safe.docx"))).toString("base64"),
      pdf: (await readFile(join(fixtureDir, "safe.pdf"))).toString("base64"),
      unsafe: (await readFile(join(fixtureDir, "unsafe.pdf"))).toString("base64"),
      spoofed: (await readFile(join(fixtureDir, "spoofed.pdf"))).toString("base64"),
    };
    await docker(compose("build", "migrate"), "private extractor image build");
    await docker(compose("up", "-d", "--wait", "--no-build", "private-document-extractor"), "private extractor start");
    const containerId = (await docker(compose("ps", "-q", "private-document-extractor"), "private extractor lookup")).trim();
    assert(containerId.length > 0, "private extractor container was not started");
    const inspect = JSON.parse(await docker(["inspect", containerId], "private extractor inspect"))[0] as { HostConfig?: { PortBindings?: Record<string, unknown> } };
    assert(Object.keys(inspect.HostConfig?.PortBindings ?? {}).length === 0, "private extractor unexpectedly has a host port");

    const network = `${project}_private-document-sandbox`;
    const probe = `
      const http = require('node:http');
      const token = process.env.TOKEN;
      const request = (body, fileName, mime, auth = token) => new Promise((resolve) => {
        const req = http.request({ host: 'private-document-extractor', port: 8083, path: '/v1/extract/private-document', method: 'POST', headers: { authorization: 'Bearer ' + auth, 'content-type': 'application/octet-stream', 'content-length': body.length, 'x-private-document-file-name': Buffer.from(fileName).toString('base64url'), 'x-private-document-mime': Buffer.from(mime).toString('base64url') } }, (res) => { let data = ''; res.on('data', (chunk) => data += chunk); res.on('end', () => resolve({ status: res.statusCode, data })); });
        req.on('error', (error) => resolve({ status: 0, data: String(error.message || error) })); req.end(body);
      });
      const cases = [
        ['text', Buffer.from(process.env.TEXT, 'base64'), 'safe.txt', 'text/plain', 200, 'Cardano private Compose smoke text'],
        ['docx', Buffer.from(process.env.DOCX, 'base64'), 'safe.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 200, 'Cardano private smoke text'],
        ['pdf', Buffer.from(process.env.PDF, 'base64'), 'safe.pdf', 'application/pdf', 200, 'Cardano private PDF smoke'],
        ['unsafe', Buffer.from(process.env.UNSAFE, 'base64'), 'unsafe.pdf', 'application/pdf', 503, null],
        ['spoofed', Buffer.from(process.env.SPOOFED, 'base64'), 'spoofed.txt', 'text/plain', 503, null],
      ];
      (async () => {
        for (const [label, body, name, mime, expected, marker] of cases) {
          const result = await request(body, name, mime);
          if (result.status !== expected || (marker && !result.data.includes(marker))) throw new Error(label + ' probe failed with status ' + result.status);
        }
        const unauthorized = await request(Buffer.from('%PDF-1.4'), 'bad.pdf', 'application/pdf', 'wrong-token');
        if (unauthorized.status !== 401) throw new Error('unauthorized probe returned ' + unauthorized.status);
      })().catch((error) => { console.error(error.message || error); process.exit(1); });
    `;
    await docker(["run", "--rm", "--network", network, "-e", `TOKEN=${token}`, "-e", `TEXT=${values.text}`, "-e", `DOCX=${values.docx}`, "-e", `PDF=${values.pdf}`, "-e", `UNSAFE=${values.unsafe}`, "-e", `SPOOFED=${values.spoofed}`, image, "node", "-e", probe], "private extractor smoke");
  }, async () => {
    let cleanupError: unknown;
    try {
      await docker(compose("down", "--volumes", "--remove-orphans"), "private extractor cleanup");
    } catch (error) {
      cleanupError = error;
    }
    try {
      await rm(fixtureDir, { recursive: true, force: true });
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError !== undefined) throw cleanupError;
  });
}

async function main(): Promise<void> {
  assertStaticContracts();
  const config = await renderedCompose();
  const { image, token } = await assertRenderedContracts(config);
  if (process.argv.includes("--smoke")) await smoke(image, token);
  console.log(process.argv.includes("--smoke") ? "Private extractor Compose verification passed" : "Private extractor Compose contract passed");
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/verify-private-extractor-compose.ts") || process.argv[1]?.replaceAll("\\", "/").endsWith("/verify-private-extractor-compose.js")) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Private extractor Compose verification failed");
    process.exitCode = 1;
  });
}
